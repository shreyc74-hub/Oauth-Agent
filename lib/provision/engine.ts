// The provisioning engine. Runs a playbook one step at a time and saves the run after every step,
// so it can pause for a person, survive a serverless timeout and resume on another instance.
//
//   app name -> plan (playbook) -> identity -> sign-up/in -> sandbox -> OAuth app -> vault -> verify -> go-live check
//
// Human in the loop: the person signs in, and approves every write before it happens.
// Full automation: the agent signs up with its own inbox and only stops at walls it should not climb
// (captchas, phone checks, device approvals, payment, legal terms).
import { randomBytes } from "node:crypto";
import type { Mode, Playbook, Run, RunEvent, Step } from "./types";
import type { Driver } from "./browser";
import { openBrowser, browserConfigured, createContext, releaseSession } from "./browser";
import { agentMail, findCode, findLink, waitForMail, type Inbox } from "./inbox";
import { putSecret, getSecret, hasSecret, vaultName, redact, recordReveal } from "./vault";
import { saveRun, getRun } from "./runs";
import { authorizeUrl, codeFromUrl, exchangeCode, newState, refreshTokens, whoami, type Http } from "./verify";
import { PLAYBOOKS, planFromGuide, mockPlanFromGuide, validatePlaybook } from "./planner";
import { slackManifest } from "./playbooks/slack";
import { upsertRow, sheetConfigured } from "./sheets";
import { mockBrowser, mockInbox, mockHttp, mockEnabled } from "./mock";
import { recover, claudeBrain, mockBrain, type Brain } from "./recover";
import { libraryGuides, matchLibrary, slugify } from "../library";
import { getGuide } from "../store";
import type { Guide } from "../schema";

export interface Deps {
  openBrowser: (o: { sessionId?: string; contextId?: string; mockFail?: string }) => Promise<Driver>;
  inbox: Inbox;
  http: Http;
  /** Picks the recovery agent's next actions. */
  brain: Brain;
  mock: boolean;
}

export function defaultDeps(): Deps {
  if (mockEnabled()) return { openBrowser: mockBrowser, inbox: mockInbox, http: mockHttp, brain: mockBrain, mock: true };
  return { openBrowser, inbox: agentMail, http: (u, i) => fetch(u, i), brain: claudeBrain, mock: false };
}

/** Missing keys or setup. Retrying or handing over won't help, so the run stops with the reason. */
export class ConfigError extends Error { name = "ConfigError"; }

export class NoGuideError extends Error {
  constructor(public app: string) { super(`There is no readiness guide for ${app} yet. The agent plans from the guide, so create the guide first.`); }
}

const TERMINAL = new Set(["verified", "needs_review", "failed", "cancelled"]);
const EMAIL_WAIT_MS = 5 * 60_000;

// ---------- Creating a run ----------

async function findGuide(app: string): Promise<Guide | null> {
  const lib = matchLibrary(app, libraryGuides());
  if (lib) return lib;
  return getGuide(slugify(app));
}

export async function planFor(app: string, deps: Deps): Promise<Playbook> {
  const guide = await findGuide(app);
  const slug = guide?.slug || slugify(app);
  if (PLAYBOOKS[slug]) return PLAYBOOKS[slug];
  if (!guide) throw new NoGuideError(app);
  if (guide.oauth && guide.oauth.supported === false) throw new Error(`${guide.name} does not offer OAuth for third-party apps: ${guide.oauth.note || "see its guide"}.`);
  return deps.mock ? mockPlanFromGuide(guide) : planFromGuide(guide);
}

/** What a real run needs before it starts. Empty when ready. */
export function missingSetup(mode: Mode, deps: Deps): string[] {
  if (deps.mock) return [];
  const need = ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "ANTHROPIC_API_KEY"];
  if (mode === "auto") need.push("AGENTMAIL_API_KEY");
  return need.filter((k) => !process.env[k]);
}

export async function createRun(input: { app: string; mode: Mode; baseUrl: string; simulateChange?: boolean }, deps = defaultDeps()): Promise<Run> {
  const missing = missingSetup(input.mode, deps);
  if (missing.length) throw new ConfigError(`Not set up for ${input.mode === "auto" ? "full automation" : "human-in-the-loop"} runs yet. Missing: ${missing.join(", ")}.`);
  const playbook = await planFor(input.app, deps);
  const problems = validatePlaybook(playbook);
  if (problems.length) throw new Error(`Plan for ${playbook.name} failed checks: ${problems.join("; ")}`);
  const id = `${playbook.slug}-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomBytes(3).toString("hex")}`;
  const short = id.slice(-6);
  const steps = playbook.steps[input.mode];
  const now = new Date().toISOString();
  const run: Run = {
    id, app: playbook.name, slug: playbook.slug, mode: input.mode, status: "queued", strategy: playbook.strategy, cursor: 0,
    steps: steps.map((s) => ({ id: s.id, title: s.title, kind: s.kind, state: "todo" })),
    vars: {
      base_url: input.baseUrl,
      redirect_uri: `${input.baseUrl}/api/oauth/callback`,
      app_name: `${playbook.name} Toolkit Test ${short}`,
      dev_name: "Toolkit Provisioning Agent",
      dev_url: input.baseUrl,
      workspace_name: `toolkit-sandbox-${short}`,
    },
    playbook,
    vault: {}, public: {}, events: [], createdAt: now, updatedAt: now,
  };
  if (deps.mock && input.simulateChange) {
    // Demo only: make the first form-filling browser step fail, as if the provider redesigned its console.
    const target = steps.find((s) => s.kind === "browser" && s.instruction && /fill|create|open the developer/i.test(s.title) && !s.write);
    if (target && "instruction" in target && target.instruction) { run.vars.mock_fail = target.instruction.slice(0, 30); log(run, "info", `Demo: simulating a console change on "${target.title}".`); }
  }
  log(run, "info", `Plan: ${playbook.name}, ${playbook.strategy} strategy, evidence ${playbook.evidence}. Sandbox: ${playbook.sandbox.kind}. ${input.mode === "auto" ? "Full automation" : "Human in the loop"}, ${steps.length} steps.`);
  await saveRun(run);
  await syncSheet(run);
  return run;
}

// ---------- Helpers ----------

function log(run: Run, kind: RunEvent["kind"], text: string, step?: string, secrets: Set<string> = new Set()) {
  run.events.push({ at: new Date().toISOString(), kind, step, text: redact(text, [...secrets]) });
  if (run.events.length > 200) run.events.splice(0, run.events.length - 200);
}

const stepOf = (run: Run) => run.playbook.steps[run.mode][run.cursor] as Step | undefined;

function needsApproval(run: Run, s: Step): boolean {
  if (run.mode !== "human") return false;
  const isWrite = (s.kind === "browser" || s.kind === "api") && s.write;
  return Boolean((isWrite || s.kind === "verify") && !run.vars[`approved:${s.id}`]);
}

function pause(run: Run, p: NonNullable<Run["pending"]>, kind: "handoff" | "approval") {
  run.pending = p;
  run.status = p.kind === "approval" ? "waiting_approval" : "waiting_human";
  run.steps[run.cursor].state = "blocked";
  log(run, kind, `${run.steps[run.cursor].title}: ${p.reason}`, p.step);
}

async function syncSheet(run: Run) {
  if (!sheetConfigured()) return;
  try { run.sheetRow = (await upsertRow(run, run.vars.base_url)) ?? run.sheetRow; }
  catch (e) { log(run, "error", `Tracker sheet not updated: ${(e as Error).message.slice(0, 160)}`); }
}

/** Values a browser instruction may use. Only the %names% the instruction mentions are loaded. */
async function variablesFor(run: Run, text: string, extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const names = [...text.matchAll(/%([a-z_]+)%/g)].map((m) => m[1]);
  const out: Record<string, string> = {};
  for (const n of names) {
    if (extra[n] !== undefined) out[n] = extra[n];
    else if (n === "email" && run.identity?.email) out[n] = run.identity.email;
    else if (n === "password") out[n] = (await getSecret(vaultName(run.slug, run.id, "password"))) || "";
    else if (run.vars[n] !== undefined) out[n] = run.vars[n];
  }
  return out;
}

// ---------- Advancing ----------

type Outcome = "done" | "pause" | "wait";

interface Ctx { run: Run; deps: Deps; deadline: number; seen: Set<string>; driver?: Driver; recovered?: Set<string> }

async function browser(ctx: Ctx): Promise<Driver> {
  if (ctx.driver) return ctx.driver;
  const { run, deps } = ctx;
  let contextId: string | undefined;
  if (!deps.mock && browserConfigured()) {
    // One browser context per provider keeps the console signed in for the next run.
    const name = vaultName(run.slug, run.id, "shared:browser_context");
    contextId = (await getSecret(name)) || undefined;
    if (!contextId) { contextId = await createContext(); await putSecret(name, contextId, `${run.app} browser context`); }
  }
  if (!deps.mock && !browserConfigured()) throw new ConfigError("The browser isn't configured: set BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID.");
  ctx.driver = await deps.openBrowser({ sessionId: run.browser?.sessionId, contextId, mockFail: deps.mock ? run.vars.mock_fail : undefined });
  run.browser = { sessionId: ctx.driver.sessionId, liveUrl: ctx.driver.liveUrl || run.browser?.liveUrl };
  return ctx.driver;
}

async function store(ctx: Ctx, label: string, value: string, secret: boolean, quiet = false) {
  const { run } = ctx;
  if (label === "client_id") run.public.clientId = value;
  if (!secret) { run.vars[label] = value; if (label !== "client_id") return; }
  ctx.seen.add(value);
  const name = vaultName(run.slug, run.id, label);
  await putSecret(name, value, `${run.app}: ${label} (run ${run.id})`);
  run.vault[label.replace(/^shared:/, "")] = name;
  if (secret && !quiet) log(run, "secret", `Stored ${label.replace(/^shared:/, "")} in the vault as ${name}. Not shown to the model or in this log.`);
}

/** After any browser action: is there a wall the agent should not climb? */
async function checkBlocker(ctx: Ctx, s: Step): Promise<Outcome | null> {
  const b = await (await browser(ctx)).blocker();
  if (!b) return null;
  if (b.kind === "signin" && ctx.run.mode === "auto" && s.kind === "browser" && /sign ?up|signup/i.test(s.title)) return null;
  return wallPause(ctx, s, b);
}

function wallPause(ctx: Ctx, s: Step, b: { kind: string; detail: string }): Outcome {
  const why: Record<string, string> = {
    captcha: "A captcha is showing. The agent does not solve captchas. Complete it in the live browser, then press Continue.",
    phone: "The provider wants a phone number or SMS code. Enter it in the live browser, then press Continue.",
    device: "The provider wants approval on another device or a passkey. Approve it, then press Continue.",
    payment: "The provider wants payment details. A person has to decide this. Complete or skip it in the live browser, then press Continue.",
    signin: "The page wants you to sign in. Sign in in the live browser, then press Continue.",
    error: "The page shows an error. Fix it in the live browser if you can, then press Continue.",
  };
  pause(ctx.run, { kind: "human", step: s.id, reason: `${why[b.kind]} (${b.detail.slice(0, 140)})`, blocker: b.kind }, "handoff");
  // The person resolves the wall; the step itself still has to finish, so Continue re-runs it.
  ctx.run.vars[`retry:${s.id}`] = "1";
  return "pause";
}

async function runStep(ctx: Ctx, s: Step): Promise<Outcome> {
  const { run, deps } = ctx;
  switch (s.kind) {
    case "identity": {
      const username = `${run.slug}-${run.id.slice(-6)}`;
      const inbox = await deps.inbox.create(username);
      run.identity = { email: inbox.email, inboxId: inbox.inboxId };
      const password = `${randomBytes(15).toString("base64url")}!a1`;
      ctx.seen.add(password);
      await store(ctx, "password", password, true);
      log(run, "step", `Agent identity ready: ${inbox.email}. Password generated straight into the vault.`, s.id);
      return "done";
    }
    case "human": {
      if (s.url) { const d = await browser(ctx); if (!d.url().startsWith("http")) await d.goto(s.url); }
      else await browser(ctx);
      pause(run, { kind: "human", step: s.id, reason: s.reason }, "handoff");
      return "pause";
    }
    case "browser": {
      if (needsApproval(run, s)) {
        pause(run, { kind: "approval", step: s.id, reason: `About to: ${s.instruction ? s.instruction.replace(/%([a-z_]+)%/g, (_, n) => (n === "password" ? "[password]" : run.vars[n] || (n === "email" ? run.identity?.email || n : n))) : s.title}` }, "approval");
        await browser(ctx);
        return "pause";
      }
      const d = await browser(ctx);
      if (s.url) await d.goto(s.url);
      if (s.instruction) {
        const r = await d.act(s.instruction, await variablesFor(run, s.instruction));
        if (!r.ok) {
          const b = await checkBlocker(ctx, s);
          if (b) return b;
          throw new Error(`the browser step did not complete (${r.message.slice(0, 160)})`);
        }
      }
      const b = await checkBlocker(ctx, s);
      if (b) return b;
      log(run, "step", `${s.title}: done.`, s.id);
      return "done";
    }
    case "capture": {
      const d = await browser(ctx);
      const value = await d.capture(s.find, s.reveal);
      await store(ctx, s.into, value, s.secret);
      if (!s.secret) log(run, "step", `${s.title}: ${s.into === "client_id" ? value : "noted"}.`, s.id);
      return "done";
    }
    case "email": {
      if (!run.identity?.inboxId) throw new Error("no agent inbox (run the identity step first)");
      const since = Number(run.vars[`since:${s.id}`] || Date.now());
      run.vars[`since:${s.id}`] = String(since);
      const left = Math.max(5_000, Math.min(60_000, ctx.deadline - Date.now() - 15_000));
      const mail = await waitForMail(deps.inbox, run.identity.inboxId, { from: s.from, since, timeoutMs: deps.mock ? 10 : left, pollMs: deps.mock ? 1 : 4000 });
      if (!mail) {
        if (Date.now() - since > EMAIL_WAIT_MS) throw new Error(`no email from ${s.from || "the provider"} after 5 minutes`);
        if (!run.vars[`waitlog:${s.id}`]) { run.vars[`waitlog:${s.id}`] = "1"; log(run, "info", `Waiting for the ${s.from || "provider"} email…`, s.id); }
        return "wait";
      }
      const d = await browser(ctx);
      if (s.extract === "link") {
        const link = findLink(mail, s.from);
        if (!link) throw new Error("the email had no usable link");
        await d.goto(link);
        log(run, "step", `${s.title}: opened the link from "${mail.subject.slice(0, 80)}".`, s.id);
      } else {
        const code = findCode(mail);
        if (!code) throw new Error("the email had no code");
        ctx.seen.add(code);
        if (s.then) {
          const r = await d.act(s.then, await variablesFor(run, s.then, { code }));
          if (!r.ok) throw new Error(`could not enter the code (${r.message.slice(0, 120)})`);
        }
        log(run, "step", `${s.title}: code read from "${mail.subject.slice(0, 80)}" and entered.`, s.id);
      }
      const b = await checkBlocker(ctx, s);
      return b ?? "done";
    }
    case "totp": {
      const d = await browser(ctx);
      const { seedFrom, totp } = await import("./totp");
      const seed = seedFrom(await d.capture(s.find));
      ctx.seen.add(seed);
      await store(ctx, "totp_seed", seed, true);
      const code = totp(seed);
      const r = await d.act(`Type %totp% into ${s.codeField} and confirm.`, { totp: code });
      if (!r.ok) throw new Error("could not confirm the authenticator code");
      log(run, "step", "Authenticator 2FA on. The seed is in the vault, so the agent can produce its own codes.", s.id);
      return "done";
    }
    case "api": {
      if (needsApproval(run, s)) {
        pause(run, { kind: "approval", step: s.id, reason: `About to call ${s.title}. This creates the app "${run.vars.app_name}" with scopes ${run.playbook.oauth.scopes.join(", ")}.` }, "approval");
        return "pause";
      }
      const h = HANDLERS[s.handler];
      if (!h) throw new Error(`unknown handler ${s.handler}`);
      await h(ctx);
      return "done";
    }
    case "verify": return verifyStep(ctx, s);
    case "golive": {
      run.goLive = run.playbook.goLive;
      log(run, "step", run.goLive.needed ? `Works for testing now. Going live needs a person: ${run.goLive.summary} (${run.goLive.humanWork.join("; ")})` : `Nothing to approve: ${run.goLive.summary}`, s.id);
      return "done";
    }
  }
}

async function verifyStep(ctx: Ctx, s: Step): Promise<Outcome> {
  const { run, deps } = ctx;
  const o = run.playbook.oauth;
  const clientId = run.public.clientId;
  const secret = await getSecret(vaultName(run.slug, run.id, "client_secret"));
  if (!clientId || !secret) throw new Error("client ID or secret missing, so there is nothing to verify");
  ctx.seen.add(secret);
  if (needsApproval(run, s)) {
    pause(run, { kind: "approval", step: s.id, reason: `About to authorize "${run.vars.app_name}" on the sandbox (scopes ${o.scopes.join(", ")}) and test the token.` }, "approval");
    await browser(ctx);
    return "pause";
  }
  const d = await browser(ctx);
  // The callback route may have stored the code while we were paused.
  const fresh = await getRun(run.id);
  if (fresh?.verify?.code && run.verify && fresh.verify.state === run.verify.state) run.verify.code = fresh.verify.code;

  if (!run.verify) {
    run.verify = { state: newState(), verifier: "" };
    const url = authorizeUrl(o, clientId, run.vars.redirect_uri, run.verify.state);
    run.public.authorizeUrl = url;
    await d.goto(url);
    const r = await d.act(o.consentInstruction, await variablesFor(run, o.consentInstruction));
    if (!r.ok) { const b = await checkBlocker(ctx, s); if (b) return b; }
  }
  let code = run.verify.code || null;
  for (let i = 0; !code && i < (deps.mock ? 1 : 10); i++) {
    code = codeFromUrl(d.url(), run.verify.state);
    if (!code && !deps.mock) await new Promise((r) => setTimeout(r, 2000));
  }
  if (!code) {
    pause(run, { kind: "human", step: s.id, reason: "Approve the consent screen in the live browser, then press Continue." }, "handoff");
    return "pause";
  }
  ctx.seen.add(code);
  try {
    const t = await exchangeCode(deps.http, o, code, run.vars.redirect_uri, clientId, secret);
    ctx.seen.add(t.access); if (t.refresh) ctx.seen.add(t.refresh);
    await store(ctx, "access_token", t.access, true);
    if (t.refresh) await store(ctx, "refresh_token", t.refresh, true);
    run.verify.who = await whoami(deps.http, o, t.access);
    if (t.refresh) {
      try {
        const r2 = await refreshTokens(deps.http, o, t.refresh, clientId, secret);
        ctx.seen.add(r2.access); if (r2.refresh) ctx.seen.add(r2.refresh);
        await store(ctx, "access_token", r2.access, true, true);
        if (r2.refresh) await store(ctx, "refresh_token", r2.refresh, true, true); // refresh tokens can rotate
        log(run, "secret", `Refresh worked: new access token${r2.refresh && r2.refresh !== t.refresh ? " and rotated refresh token" : ""} stored in the vault.`, s.id);
        run.verify.refresh = "ok";
      } catch (e) { run.verify.refresh = "failed"; log(run, "error", `Refresh failed: ${(e as Error).message}`, s.id, ctx.seen); }
    } else run.verify.refresh = "not-offered";
    run.verify.at = new Date().toISOString();
    log(run, "step", `Verified: token works for "${run.verify.who}". Refresh: ${run.verify.refresh}.`, s.id);
  } catch (e) {
    run.vars.verify_error = (e as Error).message;
    log(run, "error", `Verification failed: ${(e as Error).message}`, s.id, ctx.seen);
  }
  return "done";
}

const HANDLERS: Record<string, (ctx: Ctx) => Promise<void>> = {
  /** Slack: rotate the config token, then create the app from a manifest. Credentials come back in the response. */
  async slackManifestCreate(ctx) {
    const { run, deps } = ctx;
    const refreshName = vaultName("slack", run.id, "shared:config_refresh_token");
    const refresh = await getSecret(refreshName);
    if (!refresh) throw new Error("no Slack configuration refresh token in the vault");
    ctx.seen.add(refresh);
    const rot = await (await deps.http("https://slack.com/api/tooling.tokens.rotate", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ refresh_token: refresh }) })).json() as { ok: boolean; token?: string; refresh_token?: string; error?: string };
    if (!rot.ok || !rot.token || !rot.refresh_token) throw new Error(`tooling.tokens.rotate failed: ${rot.error || "no token"}`);
    ctx.seen.add(rot.token); ctx.seen.add(rot.refresh_token);
    await store(ctx, "shared:config_refresh_token", rot.refresh_token, true);
    const manifest = slackManifest(run.vars.app_name, run.vars.redirect_uri, run.playbook.oauth.scopes);
    const res = await (await deps.http("https://slack.com/api/apps.manifest.create", { method: "POST", headers: { authorization: `Bearer ${rot.token}`, "content-type": "application/json; charset=utf-8" }, body: JSON.stringify({ manifest: JSON.stringify(manifest) }) })).json() as { ok: boolean; app_id?: string; credentials?: Record<string, string>; oauth_authorize_url?: string; error?: string; errors?: { message: string; pointer: string }[] };
    if (!res.ok || !res.credentials) throw new Error(`apps.manifest.create failed: ${res.error || ""} ${(res.errors || []).map((e) => `${e.pointer}: ${e.message}`).join("; ")}`);
    run.public.appId = res.app_id;
    await store(ctx, "client_id", res.credentials.client_id, false);
    await store(ctx, "client_secret", res.credentials.client_secret, true);
    if (res.credentials.signing_secret) await store(ctx, "signing_secret", res.credentials.signing_secret, true);
    log(run, "step", `App ${res.app_id} created through Slack's API. Client ID ${res.credentials.client_id}. No console clicks.`, "manifest-create", ctx.seen);
  },
};

// ---------- Recovery agent ----------

/** The provider's own sites: hosts from the playbook's URLs (base domain), plus this site. */
export function allowedHosts(run: Run): string[] {
  const p = run.playbook;
  const urls = [...p.steps[run.mode].map((s) => ("url" in s ? s.url : undefined)), p.oauth.authorizeUrl, p.oauth.tokenUrl, p.oauth.whoami.url];
  const hosts = new Set<string>();
  for (const u of urls) {
    try { hosts.add(new URL(String(u)).hostname.split(".").slice(-2).join(".")); } catch { /* not a URL */ }
  }
  try { hosts.add(new URL(run.vars.base_url).hostname); } catch { /* none */ }
  return [...hosts];
}

/**
 * A browser or capture step failed. Give its goal to the recovery agent before asking a person.
 * Returns the outcome, or a note for the handoff when the agent couldn't do it either.
 */
async function tryRecovery(ctx: Ctx, s: Step, error: string): Promise<{ out: Outcome } | { note: string } | null> {
  const { run, deps } = ctx;
  if (s.kind !== "browser" && s.kind !== "capture") return null;
  if (process.env.PROVISION_RECOVERY === "0") return null;
  ctx.recovered ??= new Set();
  if (ctx.recovered.has(s.id) || Date.now() + 15_000 > ctx.deadline) return null;
  ctx.recovered.add(s.id);

  // Everything secret this run holds, so nothing the page shows can reach the model.
  for (const name of Object.values(run.vault)) { const v = await getSecret(name).catch(() => null); if (v) ctx.seen.add(v); }
  const driver = await browser(ctx);
  const names = new Set([...(("instruction" in s && s.instruction) || "").matchAll(/%([a-z_]+)%/g)].map((m) => m[1]));
  for (const n of ["app_name", "dev_name", "dev_url", "redirect_uri", "workspace_name"]) names.add(n);
  if (run.identity?.email) { names.add("email"); names.add("password"); }
  const approved = JSON.parse(run.vars[`recovery-approved:${s.id}`] || "[]") as string[];
  log(run, "agent", `Step failed (${error}). Recovery agent takes over with the step's goal.`, s.id, ctx.seen);

  const result = await recover({
    driver, brain: deps.brain, mode: run.mode, app: run.app,
    step: s.kind === "capture"
      ? { id: s.id, title: s.title, kind: "capture", find: s.find, into: s.into }
      : { id: s.id, title: s.title, kind: "browser", instruction: s.instruction, url: s.url },
    error,
    allowedHosts: allowedHosts(run),
    captureLabels: s.kind === "capture" ? [s.into] : [],
    variableNames: [...names],
    approved,
    hasInbox: Boolean(run.identity?.inboxId),
    resolveVars: (text, extra) => variablesFor(run, text, extra),
    storeValue: async (label, value) => {
      ctx.seen.add(value);
      await store(ctx, label, value, s.kind === "capture" && label === s.into ? s.secret : label !== "client_id");
    },
    readInboxCode: async () => {
      if (!run.identity?.inboxId) return null;
      const mail = await waitForMail(deps.inbox, run.identity.inboxId, { since: Date.now() - 10 * 60_000, timeoutMs: deps.mock ? 10 : 20_000, pollMs: deps.mock ? 1 : 4000 });
      const code = mail ? findCode(mail) : null;
      if (code) ctx.seen.add(code);
      return code;
    },
    redact: (t) => redact(t, [...ctx.seen]),
    trace: (t) => log(run, "agent", t, s.id, ctx.seen),
    deadline: Math.min(ctx.deadline - 10_000, Date.now() + 120_000),
  });

  switch (result.outcome) {
    case "recovered": {
      if (s.kind === "capture" && !run.vault[s.into.replace(/^shared:/, "")] && !(s.into === "client_id" && run.public.clientId)) {
        return { note: "The recovery agent said it was done, but the value never reached the vault." };
      }
      run.steps[run.cursor].recovered = true;
      log(run, "step", `${s.title}: recovered by the agent. ${result.summary}`, s.id, ctx.seen);
      if (result.fix) {
        (run.fixes ??= []).push({ step: s.id, suggestion: result.fix, at: new Date().toISOString() });
        log(run, "agent", `Suggested playbook fix for "${s.title}": ${result.fix}`, s.id, ctx.seen);
      }
      return { out: "done" };
    }
    case "wall":
      return { out: wallPause(ctx, s, result.blocker) };
    case "needs_approval":
      pause(run, { kind: "approval", step: s.id, reason: `The recovery agent wants to: ${result.instruction}`, recovery: result.instruction }, "approval");
      return { out: "pause" };
    case "gave_up":
      return { note: `The recovery agent tried${result.tried.length ? `: ${result.tried.slice(-4).join("; ")}` : " but couldn't act"}. It said: ${result.reason}` };
  }
}

/** Runs steps until the run finishes, pauses, or the time budget is used up. Safe to call repeatedly. */
export async function advance(id: string, deps = defaultDeps(), budgetMs = 240_000): Promise<Run> {
  const run = await getRun(id);
  if (!run) throw new Error("Run not found.");
  if (TERMINAL.has(run.status) || run.status === "waiting_human" || run.status === "waiting_approval") return run;
  if (run.lockUntil && run.lockUntil > Date.now()) return run;

  const ctx: Ctx = { run, deps, deadline: Date.now() + budgetMs, seen: new Set() };
  run.lockUntil = ctx.deadline + 30_000;
  run.status = "running";
  await saveRun(run);
  try {
    while (run.cursor < run.steps.length && Date.now() < ctx.deadline - 10_000) {
      const s = stepOf(run)!;
      if (s.skipIfVault && (await hasSecret(vaultName(run.slug, run.id, s.skipIfVault)))) {
        run.steps[run.cursor].state = "skipped";
        log(run, "info", `${s.title}: skipped, already in the vault from an earlier run.`, s.id);
        run.cursor++; await saveRun(run); continue;
      }
      run.steps[run.cursor].state = "doing";
      let out: Outcome;
      try { out = await runStep(ctx, s); }
      catch (e) {
        const msg = (e as Error).message.replace(/\.+$/, "");
        if ((e as Error).name === "ConfigError") {
          run.status = "failed"; run.steps[run.cursor].state = "blocked";
          log(run, "error", `Stopped: ${msg}.`, s.id, ctx.seen);
          break;
        }
        // A failed browser or capture step goes to the recovery agent first.
        let note = "";
        try {
          const rec = await tryRecovery(ctx, s, msg);
          if (rec && "out" in rec) {
            if (rec.out === "pause") break;
            run.steps[run.cursor].state = "done"; run.cursor++; await saveRun(run); continue;
          }
          if (rec) note = ` ${rec.note}`;
        } catch (re) {
          if ((re as Error).name === "ConfigError") { run.status = "failed"; log(run, "error", `Stopped: ${(re as Error).message}.`, s.id, ctx.seen); break; }
          note = ` The recovery agent hit an error: ${(re as Error).message.slice(0, 160)}.`;
        }
        // Anything else the agent can't finish becomes a handoff, not a dead run.
        const field = s.kind === "capture" ? { into: s.into, secret: s.secret, label: s.find } : undefined;
        pause(run, { kind: "human", step: s.id, reason: `The agent couldn't finish this: ${msg}.${note} Do it in the live browser${field ? ", or paste the value below (it goes straight to the vault)" : ""}, then press Continue.`, field }, "handoff");
        run.vars[`retry:${s.id}`] = "1";
        log(run, "error", msg, s.id, ctx.seen);
        out = "pause";
      }
      if (out === "pause") break;
      if (out === "wait") { await saveRun(run); continue; }
      run.steps[run.cursor].state = "done";
      run.cursor++;
      await saveRun(run);
    }
    if (run.cursor >= run.steps.length && run.status === "running") {
      run.status = run.verify?.who ? "verified" : "needs_review";
      log(run, "done", run.status === "verified"
        ? `Done. ${run.app} credentials verified against the sandbox and stored in the vault.`
        : `Finished, but the credentials are not verified${run.vars.verify_error ? `: ${run.vars.verify_error}` : ""}.`, undefined, ctx.seen);
      if (run.browser?.sessionId && !deps.mock) await releaseSession(run.browser.sessionId);
    }
  } finally {
    await ctx.driver?.detach().catch(() => undefined);
    run.lockUntil = undefined;
    await syncSheet(run);
    await saveRun(run);
  }
  return run;
}

/** A person's answer to a pause: done with a handoff, approve a write, paste a value, or cancel. */
export async function respond(id: string, action: "continue" | "approve" | "skip" | "cancel", value?: string): Promise<Run> {
  const run = await getRun(id);
  if (!run) throw new Error("Run not found.");
  if (action === "cancel") {
    run.status = "cancelled"; run.pending = undefined;
    log(run, "info", "Cancelled by a person.");
    if (run.browser?.sessionId && !mockEnabled()) await releaseSession(run.browser.sessionId);
    await saveRun(run); await syncSheet(run); await saveRun(run);
    return run;
  }
  if (!run.pending) return run;
  const p = run.pending;
  const s = run.playbook.steps[run.mode][run.cursor];
  if (action === "approve" && p.kind === "approval" && p.recovery) {
    // Approve exactly this action for the recovery agent; the step runs again and the agent may do it.
    const list = JSON.parse(run.vars[`recovery-approved:${p.step}`] || "[]") as string[];
    run.vars[`recovery-approved:${p.step}`] = JSON.stringify([...list, p.recovery]);
    run.steps[run.cursor].state = "todo";
    log(run, "approval", `Approved for the recovery agent: ${p.recovery}`, p.step);
  } else if (action === "approve" && p.kind === "approval") {
    run.vars[`approved:${p.step}`] = "1";
    run.steps[run.cursor].state = "todo";
    log(run, "approval", `Approved: ${run.steps[run.cursor].title}.`, p.step);
  } else if (action === "continue" || action === "skip") {
    if (p.field && value) {
      const ctx: Ctx = { run, deps: defaultDeps(), deadline: Date.now() + 10_000, seen: new Set([value]) };
      await store(ctx, p.field.into, value.trim(), p.field.secret);
      log(run, "step", `A person entered ${p.field.into}${p.field.secret ? " (straight into the vault)" : ""}.`, p.step);
      run.steps[run.cursor].state = "done"; run.cursor++;
    } else if (run.vars[`retry:${p.step}`] === "1" && action === "continue") {
      // A wall was cleared; run the same step again.
      run.vars[`retry:${p.step}`] = "";
      if (s.kind === "verify" && run.verify && !run.verify.code) { /* keep state, re-read the URL */ }
      run.steps[run.cursor].state = "todo";
      log(run, "handoff", `Person finished: ${run.steps[run.cursor].title}. Agent retries the step.`, p.step);
    } else if (s.kind === "verify" && action === "continue") {
      run.steps[run.cursor].state = "todo";
      log(run, "handoff", "Person approved consent. Agent reads the code.", p.step);
    } else {
      run.steps[run.cursor].state = action === "skip" ? "skipped" : "done";
      log(run, "handoff", `${action === "skip" ? "Skipped" : "Person finished"}: ${run.steps[run.cursor].title}.`, p.step);
      run.cursor++;
    }
  } else return run;
  run.pending = undefined;
  run.status = "running";
  await saveRun(run);
  return run;
}

/** Shows one stored secret to an admin. Every reveal is logged on the run. */
export async function reveal(id: string, label: string): Promise<string> {
  const run = await getRun(id);
  if (!run) throw new Error("Run not found.");
  const name = run.vault[label];
  if (!name) throw new Error(`No ${label} on this run.`);
  const v = await getSecret(name);
  if (!v) throw new Error("Not found in the vault.");
  await recordReveal(run.id, name);
  log(run, "secret", `${label} revealed to an admin.`);
  await saveRun(run);
  return v;
}

export const isTerminal = (r: Run) => TERMINAL.has(r.status);
