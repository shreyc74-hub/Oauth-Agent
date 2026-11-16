// The provisioning engine. Runs a playbook one step at a time and saves the run after every step,
// so it can pause for a person, survive a serverless timeout and resume on another instance.
//
//   app name -> plan (playbook) -> identity -> sign-up/in -> sandbox -> OAuth app -> vault -> verify -> go-live check
//
// Human in the loop: the person signs in, and approves every write before it happens.
// Full automation: the agent signs up with its own inbox and only stops at walls it should not climb
// (captchas, phone checks, device approvals, payment, legal terms).
import { randomBytes } from "node:crypto";
import { noProgress, type Assessment, type Mode, type Playbook, type Progress, type Run, type RunEvent, type SandboxCheck, type Step } from "./types";
import { checkSandbox, cachedSandbox, saveSandbox, fromPlaybook, type SandboxIo } from "./sandbox";
import { planScopes } from "./scopes";
import { offeredCredentials, chooseCredential, chooseRoute, recommendMode, stepSummary } from "./assess";
import { probeDcr, describeDcr, fetchJson, type Fetcher } from "./dcr";
import { SIGN_IN_ONLY, SIGN_IN_ONLY_WHY } from "./labels";
import type { Driver } from "./browser";
import { openBrowser, browserConfigured, createContext, releaseSession } from "./browser";
import { agentMail, findCode, findLink, waitForMail, type Inbox } from "./inbox";
import { putSecret, getSecret, hasSecret, vaultName, redact, recordReveal } from "./vault";
import { saveRun, getRun } from "./runs";
import { seedFrom, totp } from "./totp";
import { browserUseViaComposio, hostedConfigured, agentTask, continueTask, consentTask, parseAgentResult, vendorDomains, type HostedAgent, type AgentResult } from "./hosted";
import { authorizeUrl, codeFromUrl, exchangeCode, newState, refreshTokens, whoami, type Http } from "./verify";
import { PLAYBOOKS, planFromGuide, mockPlanFromGuide, validatePlaybook, guideFromBrief, briefPlaybook, type PlanTarget } from "./planner";
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
  /** Tests inject the sandbox check's network side; mock mode without it skips the check. */
  sandboxIo?: SandboxIo;
  /** Tests inject the DCR probe's fetcher; mock mode without it skips the probe. */
  dcrFetch?: Fetcher;
  /** Hosted browser agent (Browser Use via Composio). When set, full automation's browser route uses it. */
  hosted?: HostedAgent;
}

export function defaultDeps(): Deps {
  if (mockEnabled()) return { openBrowser: mockBrowser, inbox: mockInbox, http: mockHttp, brain: mockBrain, mock: true };
  return { openBrowser, inbox: agentMail, http: (u, i) => fetch(u, i), brain: claudeBrain, mock: false, hosted: hostedConfigured() ? browserUseViaComposio() : undefined };
}

/** Missing keys or setup. Retrying or handing over won't help, so the run stops with the reason. */
export class ConfigError extends Error { name = "ConfigError"; }

/**
 * Browserbase refusing to open a browser at all is an account problem, not something a person can
 * fix in a live browser that doesn't exist. Stagehand reports these as "Unknown error: <status>".
 */
export function browserAccountError(e: unknown): ConfigError | null {
  const m = String((e as Error)?.message || e);
  if (/\b402\b|payment required|minutes limit/i.test(m)) return new ConfigError("Browserbase refused to open a browser: the account is out of browser minutes (402 Payment Required). Upgrade the Browserbase plan or wait for the monthly reset, then start a new run");
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|invalid api key/i.test(m)) return new ConfigError("Browserbase rejected the API key or project ID (401/403). Check BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID");
  if (/\b429\b|too many|concurren/i.test(m)) return new ConfigError("Browserbase refused another browser: the plan's limit on browsers running at once is reached (429). Finish or cancel other runs, then start a new run");
  return null;
}

/** The vendor's own pages say a test account needs sales, a partner programme or a subscription. */
export class SandboxGatedError extends Error {
  name = "SandboxGatedError";
  constructor(public app: string, public check: SandboxCheck) {
    super(`${app}: a test account isn't self-serve, so the agent stopped before creating anything. ${check.summary || check.reason}`);
  }
}

export class NoGuideError extends Error {
  constructor(public app: string) { super(`There is no readiness guide for ${app} yet. The agent plans from the guide, so create the guide first.`); }
}

const TERMINAL = new Set(["verified", "needs_review", "failed", "cancelled"]);
const EMAIL_WAIT_MS = 5 * 60_000;

// ---------- Creating a run ----------

async function findGuide(app: string, guideSlug?: string): Promise<Guide | null> {
  // A guide the provision page just researched and saved can have a slug that differs from the typed name.
  if (guideSlug) { const g = await getGuide(slugify(guideSlug)); if (g) return g; }
  const lib = matchLibrary(app, libraryGuides());
  if (lib) return lib;
  return getGuide(slugify(app));
}

/** Step one: is a self-serve test account possible? Cached per vendor. */
export async function sandboxFor(app: string, deps: Deps, guideSlug?: string, progress: Progress = noProgress): Promise<SandboxCheck | undefined> {
  const guide = await findGuide(app, guideSlug);
  const slug = guide?.slug || slugify(app);
  if (PLAYBOOKS[slug]) return fromPlaybook(PLAYBOOKS[slug]);
  // Runs before any guide exists: a vendor with no self-serve sandbox shouldn't cost a guide first.
  const cached = await cachedSandbox(slug);
  if (cached) { progress({ id: "sandbox:cache", label: "Sandbox check: using the saved result", state: "done", detail: `${cached.verdict.replace(/_/g, " ")} (${cached.source === "run" ? "proven by a verified run" : `researched ${cached.checkedOn}`})` }); return cached; }
  if (deps.mock && !deps.sandboxIo) return { verdict: "self_serve", reason: "Demo mode: the sandbox check is skipped.", quotes: [], source: "research", checkedOn: new Date().toISOString().slice(0, 10) };
  let check: SandboxCheck;
  try {
    check = await checkSandbox({ name: guide?.name || app, slug, website: guide?.website }, deps.sandboxIo, progress);
  } catch (e) {
    progress({ id: "sandbox:research", label: "Claude researches the developer side, sandbox and OAuth availability", state: "fail", detail: (e as Error).message.slice(0, 160) });
    // Research failing is not evidence of a gate: ask the person instead of guessing.
    return { verdict: "unknown", reason: `The sandbox check couldn't finish: ${(e as Error).message.slice(0, 160)}`, quotes: [], source: "research", checkedOn: new Date().toISOString().slice(0, 10) };
  }
  await saveSandbox(slug, check).catch(() => undefined);
  return check;
}

export async function planFor(app: string, deps: Deps, guideSlug?: string, setup?: SandboxCheck, progress: Progress = noProgress, target?: PlanTarget, guideOverride?: Guide): Promise<Playbook> {
  const guide = guideOverride || (await findGuide(app, guideSlug));
  const slug = guide?.slug || slugify(app);
  if (PLAYBOOKS[slug]) return PLAYBOOKS[slug];
  if (!guide) throw new NoGuideError(app);
  // No OAuth only stops an OAuth plan: API-key vendors (Tavily, Firecrawl's keys) get an API-key plan.
  if (target?.credential !== "api_key" && guide.oauth && guide.oauth.supported === false) throw new Error(`${guide.name} does not offer OAuth for third-party apps: ${guide.oauth.note || "see its guide"}.`);
  return deps.mock ? mockPlanFromGuide(guide, target) : planFromGuide(guide, setup, progress, target);
}

/** What a real run needs before it starts. Empty when ready. */
export function missingSetup(mode: Mode, deps: Deps): string[] {
  if (deps.mock) return [];
  // Full automation through the hosted agent runs its own browser: no Browserbase needed.
  const need = mode === "auto" && deps.hosted ? ["ANTHROPIC_API_KEY", "COMPOSIO_API_KEY"] : ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "ANTHROPIC_API_KEY"];
  if (mode === "auto") need.push("AGENTMAIL_API_KEY");
  return need.filter((k) => !process.env[k]);
}

export async function createRun(input: { app: string; mode?: Mode; baseUrl: string; simulateChange?: boolean; guideSlug?: string; useCase?: string; autoStart?: boolean }, deps = defaultDeps(), progress: Progress = noProgress): Promise<Run> {
  // Each stage reports start and result, so the start page can show what is happening and why it takes time.
  const stage = async <T>(id: string, label: string, detail: string | undefined, fn: () => Promise<T>, result: (v: T) => string): Promise<T> => {
    progress({ id, label, state: "start", detail });
    try { const v = await fn(); progress({ id, label, state: "done", detail: result(v) }); return v; }
    catch (e) { progress({ id, label, state: "fail", detail: (e as Error).message.slice(0, 200) }); throw e; }
  };
  // Research needs only the model and the vault; each mode's own needs are checked when it starts.
  const missing: Record<Mode, string[]> = { human: missingSetup("human", deps), auto: missingSetup("auto", deps) };
  if (input.mode && missing[input.mode].length) {
    progress({ id: "setup", label: "Checking this deployment's setup", state: "fail", detail: `missing ${missing[input.mode].join(", ")}` });
    throw new ConfigError(`Not set up for ${input.mode === "auto" ? "full automation" : "human-in-the-loop"} runs yet. Missing: ${missing[input.mode].join(", ")}.`);
  }
  progress({ id: "setup", label: "Checking this deployment's setup", state: "done", detail: missing.auto.length ? `human in the loop ready; full automation missing ${missing.auto.join(", ")}` : "both modes ready" });

  let guide = await stage("guide", "Finding the readiness guide", input.app, () => findGuide(input.app, input.guideSlug),
    (g) => (g ? `${g.name}: ${g.evidenceLevel === "generated" ? "agent-generated guide" : "researched library guide"}${PLAYBOOKS[g.slug] ? ", plus a hand-written playbook" : ""}` : "no guide yet: checking the sandbox first, so a gated vendor costs no guide"));
  const known = PLAYBOOKS[guide?.slug || slugify(input.app)];

  // 1. Is a self-serve test setup possible, and are the sandbox and developer accounts the same?
  let sandbox = await stage("sandbox", "Is a self-serve sandbox possible?", "developer side, sandbox and OAuth app, each on its own evidence",
    () => sandboxFor(input.app, deps, input.guideSlug, progress),
    (c) => (c ? `${c.summary ? `${c.summary} ` : ""}${c.verdict.replace(/_/g, " ")}${c.relation ? `; sandbox is ${c.relation === "same" ? "the same account as the developer side" : c.relation === "separate" ? "a separate account" : "not confirmed as same or separate"}` : ""}` : "skipped (no guide)"));
  if (sandbox?.verdict === "gated") throw new SandboxGatedError(input.app, sandbox);
  // A test setup is possible (or not ruled out). The same research collected the official pages, steps and
  // endpoints, which is enough to plan from: no full guide needed. Only without that brief does the start
  // page write a full guide (and call again; the sandbox verdict is cached, so it isn't researched twice).
  let fromBrief = false;
  if (!guide && !known && sandbox?.resources) {
    guide = guideFromBrief({ name: input.app, slug: slugify(input.app) }, sandbox.resources, sandbox.summary);
    fromBrief = true;
    progress({ id: "brief", label: "Planning from the research brief (no full guide needed)", state: "done", detail: `${sandbox.resources.steps.length} steps and ${sandbox.resources.docs.length} official pages${sandbox.resources.oauth ? ", OAuth endpoints" : ""}${sandbox.resources.apiKey ? ", API key details" : ""}` });
  }
  if (!guide && !known) throw new NoGuideError(input.app);

  // 2. Which credentials does the vendor offer, and which one gets provisioned?
  const { offered, chosen, why } = await stage("credentials", "Which credentials does the vendor offer?", "from the vendor's own pages (quotes checked), the guide and any hand-written playbook",
    async () => { const offered = offeredCredentials({ sandbox, guide, playbook: known }); return { offered, ...chooseCredential(offered, sandbox) }; },
    (r) => `${[...new Set(r.offered.map((o) => o.type))].join(", ") || "none confirmed"}; provisioning ${r.chosen === "oauth" ? "an OAuth app" : "an API key"}`);

  // 3. For OAuth: could the app be created with one API call (RFC 7591)? Read-only probe of public metadata.
  let dcr: Awaited<ReturnType<typeof probeDcr>> | undefined;
  if (chosen === "oauth" && (!deps.mock || deps.dcrFetch)) {
    const base = deps.dcrFetch || fetchJson;
    const get: Fetcher = async (u) => {
      const j = await base(u).catch(() => null);
      const reg = Boolean(j && typeof j === "object" && (j as { registration_endpoint?: string }).registration_endpoint);
      progress({ id: `dcr:${u}`, label: `GET ${u}`, state: j ? "done" : "info", detail: j ? (reg ? "metadata found, lists a registration_endpoint" : "metadata found, no registration_endpoint") : "no document" });
      return j;
    };
    dcr = await stage("dcr", "Looking for Dynamic Client Registration", "public OAuth and MCP metadata; read-only, nothing is registered",
      () => probeDcr(known, guide?.website, get), (d) => describeDcr(d)).catch(() => undefined);
  }
  let route = chooseRoute({ chosen, playbook: known, dcr, sandbox });
  progress({ id: "route", label: `How the ${chosen === "oauth" ? "OAuth app" : "API key"} gets created`, state: "done", detail: `${route.method}${route.fallback ? ` (${route.fallback})` : ""}` });

  // 4. The plan, for that credential and route.
  const target: PlanTarget = { credential: chosen, dcr: route.method === "Dynamic Client Registration", keyWhere: sandbox?.offered?.find((o) => o.type === "api_key")?.where };
  // DCR and the hosted browser agent need no step-by-step browser plan: build it from the brief, no model call.
  const brief = sandbox?.resources;
  const browserRoute = route.method === "Browser automation" || chosen === "api_key";
  const noPlanCall = !known && brief && (target.dcr || (deps.hosted && browserRoute && input.mode !== "human"));
  let playbook = noPlanCall
    ? await stage("plan", "Planning the steps", "from the research brief, no model call (nobody needs click-by-click steps on this route)",
      async () => briefPlaybook({ name: guide?.name || input.app, slug: guide?.slug || slugify(input.app) }, brief!, target, dcr?.endpoints),
      (p) => `${p.strategy} strategy; ${p.steps.auto.length} fully automated steps; human-in-the-loop steps are planned only if that mode is chosen`)
    : await stage("plan", "Planning the steps", known ? "hand-written playbook" : deps.mock ? "demo plan from the guide" : "Claude writes the plan from the guide, then code checks it",
      () => planFor(input.app, deps, input.guideSlug, sandbox, progress, target, fromBrief ? guide || undefined : undefined),
      (p) => `${p.strategy} strategy; ${p.steps.human.length} steps with a person, ${p.steps.auto.length} fully automated; evidence ${p.evidence}`);
  if (target.dcr && dcr?.authorizationEndpoint && dcr.tokenEndpoint) {
    // Clients registered there authorize against that server's own endpoints.
    playbook = { ...playbook, strategy: "dcr", oauth: { ...playbook.oauth, authorizeUrl: dcr.authorizationEndpoint, tokenUrl: dcr.tokenEndpoint } };
  }

  // 5. Scopes from the use case (OAuth only), plus one read-only call verification makes with the new token.
  const useCase = String(input.useCase || "").trim().slice(0, 600);
  const scopePlan = useCase && chosen === "oauth"
    ? await stage("scopes", "Mapping the use case to scopes", useCase, () => planScopes({ useCase, guide, playbook, mock: deps.mock }),
      (s) => `${s.scopes.join(", ")}${s.testCall ? `; test call ${s.testCall.label}` : "; no test call"}`)
    : (chosen === "oauth" && progress({ id: "scopes", label: "Scopes", state: "info", detail: `no use case given; using the plan's scopes (${playbook.oauth.scopes.join(", ")}). The run will be verified for sign-in only.` }), undefined);
  if (scopePlan) playbook = { ...playbook, oauth: { ...playbook.oauth, scopes: scopePlan.scopes } };

  sandbox = oauthFromOtherEvidence(sandbox, { guide, dcr, playbook });
  if (sandbox?.verdict === "unknown") {
    // No confirmed evidence either way: the person decides before any browser time is spent.
    const check: Step = { kind: "human", id: "sandbox-check", title: "Decide: no confirmed self-serve sandbox", noBrowser: true,
      reason: `Couldn't confirm a self-serve test account for ${playbook.name}. ${sandbox.summary ? `${sandbox.summary} ` : ""}${sandbox.humanPath ? `If it turns out to be gated: ${sandbox.humanPath} ` : ""}The evidence is under "Sandbox check" below. Press Continue to try anyway, or Cancel.` };
    playbook = { ...playbook, steps: { human: [check, ...playbook.steps.human], auto: [check, ...playbook.steps.auto] } };
  }
  if (deps.hosted && await stillNeedsBrowser(playbook)) {
    // An API playbook whose first run needs a browser for a token (Slack's app configuration token): the
    // hosted agent gets only the token, the playbook's API step creates the app, later runs skip the browser.
    playbook = withHostedBootstrap(playbook);
    route = { ...route, method: "Hosted browser agent for the token, then the API", detail: `Browser Use signs up and generates the token ${playbook.name}'s API needs; this app stores it and creates the app through the API. Later runs reuse the token with no browser.`, executable: true };
    progress({ id: "route", label: "Browser route", state: "info", detail: "Browser Use fetches the API token once; the app is created through the API" });
  } else if (deps.hosted && playbook.strategy === "browser") {
    // Full automation hands the browser part to the hosted agent; human in the loop keeps our live browser.
    playbook = withHostedSteps(playbook, sandbox);
    route = { ...route, method: "Hosted browser agent", detail: `Browser Use (through Composio) signs up and creates the ${chosen === "oauth" ? "OAuth app" : "API key"} from the research. This app reads email codes for it, stores the secret in the vault and verifies it.`, executable: true };
    progress({ id: "route", label: "Browser route", state: "info", detail: "full automation uses the hosted browser agent (Browser Use via Composio)" });
  } else if (deps.hosted && playbook.strategy === "api" && playbook.steps.auto.some((s) => BROWSERISH.has(s.kind))) {
    // The API's token is on file (Slack's config refresh token): creating the app needs no browser at all.
    // Sign-up and token steps go; the hosted browser only signs in for the consent screen at verification.
    playbook = { ...playbook, steps: { ...playbook.steps, auto: playbook.steps.auto.filter((s) => !BROWSERISH.has(s.kind)) } };
    route = { ...route, method: "Management API (token on file)", detail: `The token ${playbook.name}'s API needs is already in the vault, so the app is created with API calls only. The hosted browser signs in only to approve the consent screen at verification.`, executable: true };
    progress({ id: "route", label: "API route", state: "info", detail: "token on file: no browser to create the app" });
  }
  const problems = validatePlaybook(playbook);
  if (problems.length) throw new Error(`Plan for ${playbook.name} failed checks: ${problems.join("; ")}`);

  // 6. The assessment, and the mode the agent recommends. The person chooses the mode last.
  const rec = recommendMode({ missing, playbook, sandbox, route });
  const assessment: Assessment = {
    feasible: true,
    accounts: { relation: sandbox?.relation || playbook.sandbox.relation || "unknown", sandbox: sandbox?.parts?.find((p) => p.role === "sandbox")?.name || playbook.sandbox.kind, developer: sandbox?.parts?.find((p) => p.role === "developer_account")?.name || `${playbook.name} developer account` },
    credentials: { offered, chosen, why }, route, ...rec, steps: stepSummary(playbook),
  };
  progress({ id: "assess", label: "Recommendation", state: "done", detail: `${rec.recommendedMode === "auto" ? "full automation" : "human in the loop"}: ${rec.recommendWhy}` });

  const id = `${playbook.slug}-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomBytes(3).toString("hex")}`;
  const short = id.slice(-6);
  const mode = input.mode || rec.recommendedMode;
  const now = new Date().toISOString();
  const run: Run = {
    id, app: playbook.name, slug: playbook.slug, mode, status: input.mode ? "queued" : "ready", strategy: playbook.strategy, cursor: 0,
    steps: playbook.steps[mode].map((s) => ({ id: s.id, title: s.title, kind: s.kind, state: "todo" })),
    vars: {
      base_url: input.baseUrl,
      redirect_uri: `${input.baseUrl}/api/oauth/callback`,
      app_name: `${playbook.name} Toolkit Test ${short}`,
      dev_name: "Toolkit Provisioning Agent",
      dev_url: input.baseUrl,
      workspace_name: `toolkit-sandbox-${short}`,
      first_name: "Toolkit",
      last_name: "Agent",
      company: "Toolkit Test",
    },
    playbook,
    sandbox, assessment, scopePlan, dcr,
    vault: {}, public: {}, events: [], createdAt: now, updatedAt: now,
  };
  if (useCase) run.vars.use_case = useCase;
  if (deps.mock && input.simulateChange) run.vars.simulate_change = "1";
  if (sandbox) log(run, "info", `Sandbox check: ${sandbox.verdict.replace(/_/g, " ")} (${sandbox.source}). ${sandbox.reason}`);
  log(run, "info", `Credentials offered: ${[...new Set(offered.map((o) => o.type))].join(", ") || "none confirmed"}. ${why}`);
  log(run, "info", `Route: ${route.method}. ${route.detail}${route.fallback ? ` ${route.fallback}.` : ""}`);
  if (dcr) log(run, "info", `Dynamic Client Registration: ${describeDcr(dcr)}`);
  if (scopePlan) log(run, "info", `Scopes for "${useCase}": ${scopePlan.scopes.join(", ")}.${scopePlan.testCall ? ` Verification will also call ${scopePlan.testCall.label}.` : " No test call chosen; verification uses the identity call only."}${scopePlan.notes.length ? ` Notes: ${scopePlan.notes.join(" ")}` : ""}`);
  log(run, "info", `Plan: ${playbook.name}, ${playbook.strategy} strategy, evidence ${playbook.evidence}. Sandbox: ${playbook.sandbox.kind}. Recommended: ${rec.recommendedMode === "auto" ? "full automation" : "human in the loop"} (${rec.recommendWhy})`);
  if (input.mode === "human") await planHumanSteps(run, deps);
  if (input.mode) beginMode(run, input.mode);
  else if (input.autoStart && rec.modes.auto.available) {
    // Zero-touch: research done, full automation starts by itself.
    beginMode(run, "auto");
    log(run, "info", "Started full automation automatically when the research finished.");
  }
  await stage("save", run.status === "queued" ? "Saving the run" : "Saving the plan", undefined, async () => { await saveRun(run); await syncSheet(run); }, () => (run.status === "queued" ? `run ${run.id}${input.autoStart && !input.mode ? ", started in full automation" : ""}` : `ready: ${run.id}. Choose how to run it.`));
  return run;
}

/** Sets the steps for a mode and queues the run. */
function beginMode(run: Run, mode: Mode) {
  run.mode = mode;
  run.steps = run.playbook.steps[mode].map((s) => ({ id: s.id, title: s.title, kind: s.kind, state: "todo" }));
  run.cursor = 0;
  run.status = "queued";
  if (run.vars.simulate_change) {
    // Demo only: make the first form-filling browser step fail, as if the provider redesigned its console.
    const target = run.playbook.steps[mode].find((s) => s.kind === "browser" && s.instruction && /fill|create|open the developer/i.test(s.title) && !s.write);
    if (target && "instruction" in target && target.instruction) { run.vars.mock_fail = target.instruction.slice(0, 30); log(run, "info", `Demo: simulating a console change on "${target.title}".`); }
  }
  log(run, "info", `Started: ${mode === "auto" ? "full automation" : "human in the loop"}, ${run.steps.length} steps.${run.assessment && mode !== run.assessment.recommendedMode ? " (Not the recommended mode.)" : ""}`);
}

/** Human-in-the-loop steps for a plan built from the brief: written only when someone picks that mode. */
async function planHumanSteps(run: Run, deps: Deps) {
  if (!run.playbook.humanPlanPending) return;
  const brief = run.sandbox?.resources;
  const guide = brief ? guideFromBrief({ name: run.app, slug: run.slug }, brief, run.sandbox?.summary) : undefined;
  const target: PlanTarget = { credential: run.playbook.credential === "api_key" ? "api_key" : "oauth", dcr: run.playbook.strategy === "dcr" };
  const full = await planFor(run.app, deps, undefined, run.sandbox, noProgress, target, guide);
  run.playbook = { ...run.playbook, steps: { ...run.playbook.steps, human: full.steps.human }, humanPlanPending: false };
  log(run, "info", `Planned the human-in-the-loop steps (${full.steps.human.length}).`);
}

/** The person's choice after reading the assessment: run it with a person, or fully automated. */
export async function startRun(id: string, mode: Mode, deps = defaultDeps()): Promise<Run> {
  const run = await getRun(id);
  if (!run) throw new Error("Run not found.");
  if (run.status !== "ready") throw new Error(`This run has already started (${run.status}).`);
  const missing = missingSetup(mode, deps);
  if (missing.length) throw new ConfigError(`Not set up for ${mode === "auto" ? "full automation" : "human-in-the-loop"} runs yet. Missing: ${missing.join(", ")}.`);
  if (mode === "human") await planHumanSteps(run, deps);
  beginMode(run, mode);
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
    else if (n === "password") out[n] = (await getSecret(run.vault.password || vaultName(run.slug, run.id, "password"))) || "";
    else if (run.vars[n] !== undefined) out[n] = run.vars[n];
  }
  return out;
}

/** The hosted agent finished work inside the vendor account: with the shared mailbox, later runs sign in. */
async function markAccountExists(run: Run) {
  if (!process.env.PROVISION_INBOX_ID || !run.identity?.email || run.vars.account_exists === "1" || run.vars.hosted_no_secrets === "1") return;
  await putSecret(vaultName(run.slug, run.id, "shared:account_email"), run.identity.email, `${run.app} account exists for ${run.identity.email}`).catch(() => undefined);
  run.vars.account_exists = "1";
}

/** Bookkeeping once a browser step is done: a sign-up with the shared mailbox means the account now exists. */
async function afterBrowserStep(ctx: Ctx, s: Step) {
  const { run } = ctx;
  if (process.env.PROVISION_INBOX_ID && isSignUp(s) && run.identity?.email && !run.vars.account_exists) {
    await putSecret(vaultName(run.slug, run.id, "shared:account_email"), run.identity.email, `${run.app} account exists for ${run.identity.email}`);
  }
}

/** A human step that is only about agreeing to developer terms (not payment, phone, identity or business checks). */
export function isTermsOnly(s: Step): boolean {
  if (s.kind !== "human") return false;
  const t = `${s.title} ${s.reason}`;
  return /terms|agreement|acceptable use|\bAUP\b|policy|accept/i.test(t) && !/payment|card|billing|phone|sms|identity|id document|business verif|tax|kyc|sign in|log in|captcha/i.test(t);
}

/**
 * The OAuth part often has no quote either way (docs explain the flow but never say who may register
 * apps). If the developer side and sandbox are self-serve, nothing says "partners only", and the guide
 * lists self-serve creation steps or the vendor offers DCR, that is "likely self-serve", not unknown.
 */
export function oauthFromOtherEvidence(sb: SandboxCheck | undefined, ev: { guide?: Guide | null; dcr?: { available: boolean; kind?: string }; playbook?: Playbook }): SandboxCheck | undefined {
  if (!sb || sb.verdict !== "unknown" || !sb.parts?.length) return sb;
  const oauth = sb.parts.find((p) => p.role === "oauth_app");
  const others = sb.parts.filter((p) => p.role !== "oauth_app");
  if (!oauth || oauth.verdict !== "unknown") return sb;
  if (others.some((p) => p.verdict !== "self_serve" && p.verdict !== "likely_self_serve")) return sb;
  if (oauth.quotes.some((q) => q.found && q.says === "no")) return sb;
  const guideSteps = (ev.guide?.steps || []).some((st) => st.owner === "agent" || st.owner === "you") && ev.guide?.oauth?.supported !== false;
  const dcr = Boolean(ev.dcr?.available);
  if (!guideSteps && !dcr) return sb;
  const why = dcr ? "the vendor's OAuth metadata accepts self-registration" : "the guide lists self-serve steps for creating the app";
  const parts = sb.parts.map((p) => (p.role === "oauth_app" ? { ...p, verdict: "likely_self_serve" as const, reason: `${p.reason} No quote said who may create apps, but ${why} and nothing says partners only.` } : p));
  return { ...sb, parts, verdict: "likely_self_serve", reason: `${sb.reason} OAuth: likely self-serve because ${why}.` };
}

/** Steps that create the vendor account (as opposed to using it). */
function isSignUp(s: Step): boolean {
  if (s.kind !== "browser") return false;
  return /sign ?-?up|register|create (an |your |a )?(free )?(developer )?account|join the .*program/i.test(`${s.title} ${s.instruction || ""}`);
}

// ---------- Advancing ----------

type Outcome = "done" | "pause" | "wait";

interface Ctx { run: Run; deps: Deps; deadline: number; seen: Set<string>; driver?: Driver; recovered?: Set<string>; reopened?: Set<string> }

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
  const mockFail = deps.mock ? run.vars.mock_fail : undefined;
  const old = run.browser?.sessionId;
  try {
    ctx.driver = await deps.openBrowser({ sessionId: old, contextId, mockFail });
  } catch (e) {
    const account = browserAccountError(e);
    if (account) throw account;
    if (!old || e instanceof ConfigError) throw e;
    // The hosted browser timed out (or was released) while the run waited. Start a new one in the
    // same context, so cookies and sign-ins carry over.
    log(run, "info", `The previous browser session had ended (${(e as Error).message.slice(0, 120)}). Opened a new one; saved sign-ins carry over.`);
    ctx.driver = await deps.openBrowser({ contextId, mockFail }).catch((e2) => { throw browserAccountError(e2) || e2; });
  }
  const fresh = ctx.driver.sessionId !== old;
  run.browser = { sessionId: ctx.driver.sessionId, liveUrl: ctx.driver.liveUrl || (fresh ? undefined : run.browser?.liveUrl) };
  return ctx.driver;
}

async function store(ctx: Ctx, label: string, value: string, secret: boolean, quiet = false) {
  const { run } = ctx;
  if (label === "client_id") run.public.clientId = value;
  if (!secret) { run.vars[label] = value; if (label !== "client_id") return; }
  if (secret) ctx.seen.add(value); // a client ID is public: it stays readable in the log
  const name = vaultName(run.slug, run.id, label);
  await putSecret(name, value, `${run.app}: ${label} (run ${run.id})`);
  run.vault[label.replace(/^shared:/, "")] = name;
  if (secret && !quiet) log(run, "secret", `Stored ${label.replace(/^shared:/, "")} in the vault as ${name}. Not shown to the model or in this log.`);
}

/** After any browser action: is there a wall the agent should not climb? */
async function checkBlocker(ctx: Ctx, s: Step): Promise<Outcome | null> {
  const b = await (await browser(ctx)).blocker();
  if (!b) return null;
  // In full automation the agent has its own login (mailbox + vaulted password): a sign-in or sign-up
  // form is something it fills in, not a wall. The step's goal check decides whether it is finished.
  if (b.kind === "signin" && ctx.run.mode === "auto" && ctx.run.identity?.email) return null;
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

// ---------- Hosted browser agent (Browser Use via Composio) ----------

const HOSTED_MAX_RUNS = 8;
const HOSTED_RUN_MS = 20 * 60_000;

const BROWSERISH = new Set<Step["kind"]>(["browser", "email", "capture", "totp"]);

/**
 * An API playbook that still has browser steps in full automation (Slack's sign-up and config token).
 * Once its shared bootstrap secret is in the vault (skipIfVault), the API route needs no browser: keep it.
 */
async function stillNeedsBrowser(p: Playbook): Promise<boolean> {
  if (p.strategy !== "api") return false;
  const auto = p.steps.auto;
  if (!auto.some((s) => s.kind === "browser")) return false;
  const bootstrap = [...new Set(auto.map((s) => s.skipIfVault).filter((x): x is string => Boolean(x)))];
  for (const label of bootstrap) if (await hasSecret(vaultName(p.slug, "", label))) return false;
  return true;
}

/**
 * An API playbook's browser bootstrap (sign-up, email code, generate a token, capture it) becomes one
 * hosted token step; the playbook's API and verify steps stay. The token goes where the captures put it.
 */
export function withHostedBootstrap(p: Playbook): Playbook {
  const auto = p.steps.auto;
  const browserish = new Set(["browser", "email", "capture", "totp"]);
  const captures = auto.filter((s): s is Extract<Step, { kind: "capture" }> => s.kind === "capture");
  const clean = (t: string) => t.replace(/%([a-z_]+)%/gi, "<$1>").replace(/\s+/g, " ").trim().slice(0, 300);
  const browsers = auto.filter((s): s is Extract<Step, { kind: "browser" }> => s.kind === "browser");
  const genIdx = auto.findIndex((s) => s.kind === "capture");
  const gen = [...auto.slice(0, genIdx < 0 ? auto.length : genIdx)].reverse().find((s): s is Extract<Step, { kind: "browser" }> => s.kind === "browser");
  const token: Step = {
    kind: "agent", id: "hosted-token", credential: p.credential === "api_key" ? "api_key" : "oauth",
    title: `Sign up and get the API token (hosted browser agent)`,
    startUrl: browsers.find((s) => s.url)?.url, hints: browsers.filter((s) => s.instruction).map((s) => clean(`${s.title}: ${s.instruction}`)).slice(0, 10), docs: [],
    token: { into: captures[0]?.into || "shared:api_token", refreshInto: captures[1]?.into, what: captures.length ? captures.map((c) => c.find).join(", and ") : "an API token", where: gen?.instruction ? clean(gen.instruction) : gen?.url },
  };
  const rest = auto.filter((s) => !browserish.has(s.kind) && s.kind !== "identity");
  return { ...p, steps: { ...p.steps, auto: [{ kind: "identity", id: "identity", title: "Agent identity (shared inbox and password)" }, token, ...rest] } };
}

/** DCR wants an initial access token: the hosted agent signs up and fetches one, then registration runs again. */
function insertDcrTokenStep(run: Run, why: string) {
  run.vars.dcr_token_tried = "1";
  const endpoint = run.dcr?.registrationEndpoint || "its client registration endpoint";
  const token: Step = {
    kind: "agent", id: "dcr-token", credential: "oauth", title: "Get a registration token (hosted browser agent)",
    startUrl: run.sandbox?.signupUrl, hints: (run.sandbox?.resources?.steps || []).map((x) => `${x.title}: ${x.detail}`.slice(0, 300)).slice(0, 8), docs: (run.sandbox?.resources?.docs || []).map((d) => d.url).slice(0, 5),
    token: { into: "shared:dcr_token", what: `an API token (or "initial access token") that ${run.app}'s client registration endpoint ${endpoint} accepts, created in the admin console or the developer / API settings` },
  };
  const done = run.playbook.steps.auto.slice(0, run.cursor);
  const rest = run.playbook.steps.auto.slice(run.cursor).filter((st) => st.id !== "identity");
  const steps: Step[] = [...done, { kind: "identity", id: "identity", title: "Agent identity (shared inbox and password)" }, token, ...rest];
  run.playbook = { ...run.playbook, steps: { ...run.playbook.steps, auto: steps } };
  run.steps = [...run.steps.slice(0, run.cursor), ...steps.slice(run.cursor).map((st) => ({ id: st.id, title: st.title, kind: st.kind, state: "todo" as const }))];
  log(run, "info", `Dynamic Client Registration at ${run.app} wants a token (${why.slice(0, 120)}). The hosted browser agent signs up and fetches one, then registration runs again with it; if that fails too, the agent creates the app in the console.`);
}

/** DCR didn't work for this vendor: replace the remaining steps with the hosted browser route. */
function switchToHosted(run: Run, why: string) {
  const brief = run.sandbox?.resources;
  const base: Playbook = brief
    ? { ...briefPlaybook({ name: run.app, slug: run.slug }, brief, { credential: "oauth" }, run.dcr?.endpoints), oauth: run.playbook.oauth }
    : { ...run.playbook, strategy: "browser" };
  const hosted = withHostedSteps(base, run.sandbox).steps.auto.filter((st) => st.id !== "sandbox-check");
  const done = run.playbook.steps.auto.slice(0, run.cursor);
  run.playbook = { ...run.playbook, strategy: "browser", steps: { ...run.playbook.steps, auto: [...done, ...hosted] } };
  run.strategy = "browser";
  run.steps = [...run.steps.slice(0, run.cursor), ...hosted.map((st) => ({ id: st.id, title: st.title, kind: st.kind, state: "todo" as const }))];
  if (run.assessment) run.assessment = { ...run.assessment, route: { method: "Hosted browser agent", detail: `Dynamic Client Registration was refused (${why.slice(0, 120)}), so the hosted browser agent creates the app in the console.`, executable: true } };
  log(run, "info", `Dynamic Client Registration didn't work for ${run.app}: ${why}. Switched to the hosted browser agent: it signs up and creates the OAuth app in the console. No person needed.`);
}

/** Full automation's steps when the hosted agent does the browser work: identity, agent, verify. */
export function withHostedSteps(p: Playbook, sandbox?: SandboxCheck): Playbook {
  const auto = p.steps.auto;
  const credential = p.credential === "api_key" ? "api_key" : "oauth";
  const clean = (t: string) => t.replace(/%([a-z_]+)%/gi, "<$1>").replace(/\s+/g, " ").trim().slice(0, 300);
  const r = sandbox?.resources;
  const hints = (r?.steps || []).map((x) => clean(`${x.title}: ${x.detail}`));
  if (!hints.length) for (const s of auto) if (s.kind === "browser" && s.instruction) hints.push(clean(`${s.title}: ${s.instruction}`));
  const startUrl = sandbox?.signupUrl || auto.find((s): s is Extract<Step, { kind: "browser" }> => s.kind === "browser" && Boolean(s.url))?.url;
  const agent: Step = {
    kind: "agent", id: "hosted-agent", credential, startUrl, hints: hints.slice(0, 10), docs: (r?.docs || []).map((d) => d.url).slice(0, 5),
    title: credential === "api_key" ? "Sign up and create the API key (hosted browser agent)" : "Sign up and create the OAuth app (hosted browser agent)",
  };
  const steps: Step[] = [
    ...auto.filter((s) => s.id === "sandbox-check"),
    { kind: "identity", id: "identity", title: "Agent identity (shared inbox and password)" },
    agent,
    { kind: "verify", id: "verify", title: credential === "api_key" ? "Verify the API key" : "Verify: OAuth sign-in, token and refresh" },
    ...auto.filter((s) => s.kind === "golive"),
  ];
  return { ...p, steps: { ...p.steps, auto: steps } };
}

function hostedAgent(ctx: Ctx): HostedAgent {
  if (!ctx.deps.hosted) throw new ConfigError("No hosted browser agent is set up (COMPOSIO_API_KEY)");
  return ctx.deps.hosted;
}

async function hostedTask(ctx: Ctx, s: Extract<Step, { kind: "agent" }>): Promise<string> {
  const { run } = ctx;
  // One task per agent step: a token step and a later app or consent step each get their own.
  if (run.hosted?.task && run.vars.hosted_task_step === s.id) return run.hosted.task;
  const sharePassword = Boolean(run.vault.password) && run.vars.hosted_no_secrets !== "1";
  const task = agentTask({
    app: run.app, credential: s.credential, email: run.identity?.email || "", accountExists: run.vars.account_exists === "1",
    passwordAlias: sharePassword ? "account_password" : undefined, startUrl: s.startUrl, hints: s.hints, docs: s.docs,
    values: { first_name: run.vars.first_name, last_name: run.vars.last_name, company: run.vars.company, app_name: run.vars.app_name, workspace_name: run.vars.workspace_name, redirect_uri: run.vars.redirect_uri, dev_url: run.vars.dev_url },
    scopes: run.playbook.oauth.scopes, token: s.token ? { what: s.token.what, where: s.token.where } : undefined,
  });
  run.hosted = { runs: 0, ...run.hosted, task };
  run.vars.hosted_task_step = s.id;
  return task;
}

/** Starts the next hosted run in the job's browser session. The password goes as a bound secret, never in the task. */
async function startHosted(ctx: Ctx, s: Extract<Step, { kind: "agent" }>, task: string, label: string): Promise<Outcome> {
  const { run } = ctx;
  const agent = hostedAgent(ctx);
  const h = (run.hosted ??= { runs: 0 });
  if (h.runs >= HOSTED_MAX_RUNS) throw new Error(`the hosted agent needed more than ${HOSTED_MAX_RUNS} runs without finishing`);
  const secrets: { alias: string; value: string; domains: string[] }[] = [];
  if (run.vault.password && run.vars.hosted_no_secrets !== "1") {
    const pw = await getSecret(run.vault.password);
    const domains = vendorDomains([s.startUrl, ...s.docs, run.playbook.oauth.authorizeUrl, run.playbook.oauth.tokenUrl]);
    if (pw && domains.length) { ctx.seen.add(pw); secrets.push({ alias: "account_password", value: pw, domains }); }
  }
  let started: { runId: string; sessionId: string };
  try { started = await agent.start({ task, sessionId: h.sessionId, secrets }); }
  catch (e) {
    if (!secrets.length || !/secret|binding|integration/i.test((e as Error).message)) throw e;
    // The account can't pass a bound secret: let the agent pick its own password (later runs sign in by email).
    run.vars.hosted_no_secrets = "1";
    h.task = undefined;
    const plain = await hostedTask(ctx, s);
    log(run, "info", `The hosted agent's account doesn't accept bound secrets, so the agent chooses its own ${run.app} password. Later runs sign in with the email code or link.`, s.id);
    started = await agent.start({ task: label === "first" ? plain : task, sessionId: h.sessionId });
  }
  h.sessionId = started.sessionId;
  h.runId = started.runId;
  h.runs++;
  run.vars.hosted_started = String(Date.now());
  log(run, "agent", `Hosted agent run ${h.runs} started${h.runs > 1 ? " in the same browser" : ""}: ${label === "first" ? `sign up and create the ${s.credential === "api_key" ? "API key" : "OAuth app"}` : label}.`, s.id, ctx.seen);
  if (!run.browser?.liveUrl) { const u = await agent.liveUrl(started.runId).catch(() => undefined); if (u) run.browser = { sessionId: "", liveUrl: u }; }
  await saveRun(run);
  return "wait";
}

/** Near the end of this invocation: idle so the loop ends, instead of calling the APIs in a tight loop. */
async function idleUntilDeadline(ctx: Ctx) {
  if (Date.now() < ctx.deadline - 25_000) return;
  await new Promise((res) => setTimeout(res, Math.max(0, ctx.deadline - 9_000 - Date.now())));
}

/** Waits for the current hosted run; null when it is still going at the end of this invocation. */
async function pollHosted(ctx: Ctx, runId: string) {
  const { run, deps } = ctx;
  const agent = hostedAgent(ctx);
  const since = Number(run.vars.hosted_started || Date.now());
  run.waitingFor = { what: "the hosted browser agent (Browser Use) to finish its run", since, until: since + HOSTED_RUN_MS, hint: run.browser?.liveUrl ? "Watch it in the live view." : undefined };
  for (;;) {
    const r = await agent.get(runId);
    if (run.hosted) run.hosted.lastStatus = r.status;
    if (r.status === "completed" || r.status === "failed" || r.status === "cancelled") { run.waitingFor = undefined; return r; }
    if (Date.now() - since > HOSTED_RUN_MS) { run.waitingFor = undefined; throw new Error(`the hosted agent's run was still ${r.status} after ${HOSTED_RUN_MS / 60_000} minutes`); }
    if (!run.browser?.liveUrl) { const u = await agent.liveUrl(runId).catch(() => undefined); if (u) run.browser = { sessionId: "", liveUrl: u }; }
    if (deps.mock) return null;
    if (Date.now() > ctx.deadline - 25_000) { await idleUntilDeadline(ctx); return null; }
    await new Promise((res) => setTimeout(res, 5000));
  }
}

/**
 * Pure: is this mail from the vendor? The sender's domain is one of the vendor's (or a subdomain of one),
 * or the sender or subject names the vendor. The shared mailbox gets mail for every run at once, so a run
 * must never take another vendor's code or link.
 */
export function mailFromVendor(m: { from: string; subject: string }, words: string[], domains: string[]): boolean {
  const sender = (m.from.match(/@([a-z0-9.-]+)/i)?.[1] || "").toLowerCase();
  const bases = new Set(domains.map((d) => d.toLowerCase().split(".").slice(-2).join(".")));
  if (sender && bases.has(sender.split(".").slice(-2).join("."))) return true;
  const text = `${m.from} ${m.subject}`.toLowerCase();
  return words.some((w) => new RegExp(`\\b${w.replace(/[^a-z0-9]/gi, "")}\\b`, "i").test(text));
}

/** The agent stopped for an email: read the code or link from our inbox and resume the same browser. */
async function hostedMail(ctx: Ctx, s: Extract<Step, { kind: "agent" }>, base: string): Promise<Outcome> {
  const { run, deps } = ctx;
  if (!run.identity?.inboxId) throw new Error("no agent inbox (run the identity step first)");
  const since = Number(run.vars.hosted_started || Date.now());
  const used = new Set<string>(JSON.parse(run.vars.hosted_mails || "[]"));
  const words = [run.slug.split(/[-_]/)[0], run.app.toLowerCase().split(/\s+/)[0]].filter((w) => w && w.length > 2);
  const domains = vendorDomains([s.startUrl, ...s.docs, run.playbook.oauth.authorizeUrl, run.playbook.oauth.tokenUrl, run.sandbox?.resources?.website ? `https://${run.sandbox.resources.website}` : undefined, run.sandbox?.signupUrl]);
  const end = Math.min(ctx.deadline - 20_000, Date.now() + (deps.mock ? 0 : 60_000));
  let mail: Awaited<ReturnType<Inbox["list"]>>[number] | undefined;
  do {
    const mails = (await deps.inbox.list(run.identity.inboxId)).filter((m) => !used.has(m.id) && (!m.at || Date.parse(m.at) >= since - 60_000));
    // One mailbox serves every run at once: only this vendor's mail, never "any new mail".
    mail = mails.find((m) => mailFromVendor(m, words, domains));
    if (mail || Date.now() >= end) break;
    await new Promise((res) => setTimeout(res, 4000));
  } while (Date.now() < end);
  if (!mail) {
    run.waitingFor = { what: `an email from ${run.app} at ${run.identity.email || "the agent's inbox"}`, since, until: since + EMAIL_WAIT_MS };
    if (Date.now() - since > EMAIL_WAIT_MS) { run.waitingFor = undefined; throw new Error(`the hosted agent is waiting for an email from ${run.app}, but none reached ${run.identity.email} in 5 minutes`); }
    if (!deps.mock) await idleUntilDeadline(ctx);
    return "wait";
  }
  run.waitingFor = undefined;
  used.add(mail.id);
  run.vars.hosted_mails = JSON.stringify([...used].slice(-20));
  const wantLink = run.vars.hosted_expects === "link";
  const code = wantLink ? null : findCode(mail);
  const link = code ? null : findLink(mail, words[0]);
  if (!code && !link) throw new Error(`the email "${mail.subject.slice(0, 60)}" had no code or link the agent could read`);
  ctx.seen.add(String(code || link));
  run.vars.hosted_expects = "";
  log(run, "step", `${s.title}: ${code ? "code" : "sign-in link"} read from "${mail.subject.slice(0, 80)}" and passed to the hosted agent.`, s.id, ctx.seen);
  return startHosted(ctx, s, continueTask(base, code ? { code } : { link: link! }), code ? "enter the emailed code and continue" : "open the emailed link and continue");
}

/** Pure: authenticator codes for the next few 30-second windows, with their UTC times, so a code is still valid when the agent types it. */
export function totpWindows(seed: string, now = Date.now(), count = 8): { from: string; to: string; code: string }[] {
  const start = Math.floor(now / 30_000) * 30_000;
  const hms = (t: number) => new Date(t).toISOString().slice(11, 19);
  return Array.from({ length: count }, (_, i) => { const t = start + i * 30_000; return { from: hms(t), to: hms(t + 30_000), code: totp(seed, t) }; });
}

/** The agent set up or needs two-step verification: keep the setup key (shared per vendor) and hand it codes. */
async function hostedTotp(ctx: Ctx, s: Extract<Step, { kind: "agent" }>, a: AgentResult, base: string): Promise<Outcome> {
  const { run } = ctx;
  if (a.totpSecret) {
    const seed = seedFrom(a.totpSecret);
    ctx.seen.add(a.totpSecret); ctx.seen.add(seed);
    await store(ctx, "shared:totp_seed", seed, true);
  }
  const name = run.vault.totp_seed || vaultName(run.slug, run.id, "shared:totp_seed");
  const seed = await getSecret(name);
  if (!seed) {
    run.vars[`retry:${s.id}`] = "1";
    run.vars.hosted_wall = "an authenticator code, with no setup key on file";
    pause(run, { kind: "human", step: s.id, reason: `${run.app} asks for an authenticator code, but no setup key was captured for this account. Enter the code in the live view, then press Continue.` }, "handoff");
    return "pause";
  }
  run.vault.totp_seed = name;
  ctx.seen.add(seed);
  const codes = totpWindows(seed);
  for (const c of codes) ctx.seen.add(c.code);
  log(run, "step", `${s.title}: ${a.totpSecret ? "authenticator set up; the setup key went straight to the vault, so later runs can sign in too. " : ""}Codes generated from the stored key and passed to the hosted agent.`, s.id, ctx.seen);
  return startHosted(ctx, s, continueTask(base, { totp: codes }), "enter the authenticator code and continue");
}

/** What the agent reported: store secrets, resume for email, hand walls to a person, or finish. */
async function hostedResult(ctx: Ctx, s: Extract<Step, { kind: "agent" }>, a: AgentResult, base: string): Promise<Outcome> {
  const { run } = ctx;
  if (a.clientSecret) ctx.seen.add(a.clientSecret);
  if (a.apiKey) ctx.seen.add(a.apiKey);
  if (a.totpSecret) { ctx.seen.add(a.totpSecret); ctx.seen.add(seedFrom(a.totpSecret)); }
  if (a.totpSecret && a.status === "done") await store(ctx, "shared:totp_seed", seedFrom(a.totpSecret), true);
  if (a.clientId) await store(ctx, "client_id", a.clientId, false);
  if (a.clientSecret) await store(ctx, "client_secret", a.clientSecret, true);
  if (a.apiKey) await store(ctx, "api_key", a.apiKey, true);
  if (a.appUrl) run.public.sandboxUrl = a.appUrl;
  const notes = a.notes.length ? ` Notes: ${a.notes.join("; ").slice(0, 300)}` : "";
  if (a.status === "needs_totp" || (a.totpSecret && a.status !== "done")) return hostedTotp(ctx, s, a, base);
  if (a.status === "waiting_for_email") {
    run.vars.hosted_expects = a.expects || "code";
    log(run, "agent", `The hosted agent is waiting for an email ${a.expects === "link" ? "link" : "code"} from ${run.app}.${notes}`, s.id, ctx.seen);
    return hostedMail(ctx, s, base);
  }
  if (a.status === "wall") {
    run.vars.hosted_wall = a.wall || "a mandatory check";
    run.vars[`retry:${s.id}`] = "1";
    pause(run, { kind: "human", step: s.id, reason: `The hosted agent stopped at a mandatory check it must not solve: ${run.vars.hosted_wall}. Do that step in the live view${run.browser?.liveUrl ? "" : " (Browser Use's live view)"}, then press Continue; the agent carries on in the same browser.`, blocker: run.vars.hosted_wall }, "handoff");
    return "pause";
  }
  if (s.token && a.status === "done") {
    // A token step: store the token for the API or DCR call that comes next, and for later runs.
    if (!a.token) {
      pause(run, { kind: "human", step: s.id, reason: `The hosted agent finished but didn't return ${s.token.what}. Generate it in the live view and paste it below. It goes straight to the vault.${notes}`, field: { into: s.token.into, secret: true, label: s.token.what } }, "handoff");
      return "pause";
    }
    ctx.seen.add(a.token); if (a.refreshToken) ctx.seen.add(a.refreshToken);
    await store(ctx, s.token.into, a.token, true);
    if (a.refreshToken && s.token.refreshInto) await store(ctx, s.token.refreshInto, a.refreshToken, true);
    if (a.tokenScheme) run.vars.token_scheme = a.tokenScheme;
    log(run, "step", `${s.title}: done in ${run.hosted?.runs || 1} hosted run(s). The token went straight to the vault; the next step creates the app through the API with it${s.token.into.startsWith("shared:") ? ", and later runs reuse it with no browser" : ""}.${notes}`, s.id, ctx.seen);
    await markAccountExists(run);
    return "done";
  }
  const need = s.credential === "api_key" ? (a.apiKey ? [] : ["API key"]) : [a.clientId ? "" : "client ID", a.clientSecret ? "" : "client secret"].filter(Boolean);
  if (a.status === "done") await markAccountExists(run); // signed in far enough to create something
  if (a.status === "done" && !need.length) {
    log(run, "step", `${s.title}: done in ${run.hosted?.runs || 1} hosted run(s).${a.clientId ? ` Client ID ${a.clientId}.` : ""}${a.appUrl ? ` App page: ${a.appUrl}.` : ""} The ${s.credential === "api_key" ? "key" : "secret"} went straight to the vault.${notes}`, s.id, ctx.seen);
    return "done";
  }
  if (a.status === "done") {
    // Created, but a value didn't come back: a person reads it off the page into the vault.
    const into = s.credential === "api_key" ? "api_key" : a.clientId ? "client_secret" : "client_id";
    pause(run, { kind: "human", step: s.id, reason: `The hosted agent created it but didn't return the ${need.join(" and ")}.${a.appUrl ? ` Open ${a.appUrl} (signed in as ${run.identity?.email}),` : " Open the app's page in the live view,"} reveal it, and paste it below. It goes straight to the vault.${notes}`, field: { into, secret: into !== "client_id", label: need[0] } }, "handoff");
    return "pause";
  }
  throw new Error(`the hosted agent couldn't finish.${notes || " It gave no reason."}`);
}

async function hostedStep(ctx: Ctx, s: Extract<Step, { kind: "agent" }>): Promise<Outcome> {
  const { run } = ctx;
  const base = await hostedTask(ctx, s);
  const h = run.hosted!;
  if (run.vars[`resume:${s.id}`] === "1") {
    run.vars[`resume:${s.id}`] = "";
    if (!h.runId) return startHosted(ctx, s, continueTask(base, { personHandled: run.vars.hosted_wall }), "continue after the person's help");
  }
  if (!h.runId) {
    if (run.vars.hosted_expects) return hostedMail(ctx, s, base);
    return startHosted(ctx, s, base, "first");
  }
  const r = await pollHosted(ctx, h.runId);
  if (!r) return "wait";
  h.runId = undefined;
  if (r.status !== "completed") throw new Error(`the hosted agent's run ${r.status}${r.error ? `: ${r.error.slice(0, 160)}` : ""}`);
  return hostedResult(ctx, s, parseAgentResult(r.result), base);
}

/** The consent task: in the job's browser when there is one, else with the account details to sign in or sign up. */
function consentFor(run: Run, url: string): string {
  const account = run.hosted?.sessionId ? undefined : { email: run.identity?.email || "", exists: run.vars.account_exists === "1", passwordAlias: run.vault.password && run.vars.hosted_no_secrets !== "1" ? "account_password" : undefined, first_name: run.vars.first_name, last_name: run.vars.last_name, company: run.vars.company };
  return consentTask(run.app, url, run.vars.redirect_uri, account);
}

/** Verification consent in the hosted browser. The callback route catches the code. */
async function hostedConsent(ctx: Ctx, s: Step, url: string): Promise<Outcome | "code"> {
  const { run } = ctx;
  const h = (run.hosted ??= { runs: 0 });
  await saveRun(run); // picks up a code the callback stored meanwhile
  if (run.verify?.code) return "code";
  if (!h.consent) {
    h.consent = true;
    await saveRun(run); // the state must be stored before the browser can reach the callback
    return startHosted(ctx, { kind: "agent", id: s.id, title: s.title, credential: "oauth", hints: [], docs: [] }, consentFor(run, url), h.sessionId ? "approve the OAuth consent screen" : "sign in (or sign up) and approve the OAuth consent screen");
  }
  if (h.runId) {
    const r = await pollHosted(ctx, h.runId);
    if (!r) return "wait";
    h.runId = undefined;
    await saveRun(run); // picks up a code the callback stored meanwhile
    if (run.verify?.code) return "code";
    const a = parseAgentResult(r.result);
    if (a.status === "needs_totp") return hostedTotp(ctx, { kind: "agent", id: s.id, title: s.title, credential: "oauth", hints: [], docs: [] }, a, consentFor(run, url));
    if (a.status === "waiting_for_email") { run.vars.hosted_expects = a.expects || "code"; }
    else {
      const why = a.status === "wall" ? `it stopped at a mandatory check: ${a.wall || "unknown"}` : `it couldn't complete the consent screen${a.notes.length ? ` (${a.notes.join("; ").slice(0, 200)})` : ""}`;
      pause(run, { kind: "human", step: s.id, reason: `The hosted agent didn't finish the OAuth consent: ${why}. Do it in the live view, then press Continue.` }, "handoff");
      return "pause";
    }
  }
  const fake: Extract<Step, { kind: "agent" }> = { kind: "agent", id: s.id, title: s.title, credential: "oauth", hints: [], docs: [] };
  if (run.vars.hosted_expects) return hostedMail(ctx, fake, consentFor(run, url));
  // A person pressed Continue but no code arrived: try the consent screen once more in the same browser.
  return startHosted(ctx, fake, consentFor(run, url), "try the consent screen again");
}

async function runStep(ctx: Ctx, s: Step): Promise<Outcome> {
  const { run, deps } = ctx;
  switch (s.kind) {
    case "identity": {
      const shared = process.env.PROVISION_INBOX_ID?.trim();
      if (shared) {
        // One mailbox for every run, and one login per vendor: the first run signs up, later runs sign in.
        const inbox = await deps.inbox.get(shared);
        run.identity = { email: inbox.email, inboxId: inbox.inboxId };
        const pwName = vaultName(run.slug, run.id, "shared:password");
        let password = await getSecret(pwName);
        const exists = Boolean(password) && (await hasSecret(vaultName(run.slug, run.id, "shared:account_email")));
        if (!password) { password = `${randomBytes(15).toString("base64url")}!a1`; await putSecret(pwName, password, `${run.app} login for ${inbox.email}`); }
        ctx.seen.add(password);
        run.vault.password = pwName;
        if (exists) run.vars.account_exists = "1";
        log(run, "step", exists
          ? `Using the shared mailbox ${inbox.email}. It already has a ${run.app} account, so the agent signs in instead of signing up.`
          : `Using the shared mailbox ${inbox.email}. First ${run.app} account for it: the agent signs up; the password goes straight into the vault and is reused by later runs.`, s.id);
        return "done";
      }
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
      if (run.mode === "auto" && s.id === "sandbox-check") {
        // Full automation doesn't ask: a truly gated vendor stops at its own wall, which is handed over.
        log(run, "info", "Sandbox not confirmed; full automation tries anyway and hands over if it meets a wall.", s.id);
        return "done";
      }
      if (run.mode === "auto" && process.env.PROVISION_ACCEPT_TERMS === "1" && isTermsOnly(s)) {
        // Authorized by the owner (PROVISION_ACCEPT_TERMS=1): accept developer terms for test accounts.
        const d = await browser(ctx);
        if (s.url) await d.goto(s.url);
        const accept = "Accept the developer terms or agreement shown on this page: tick the agreement checkbox if there is one, then press the button that accepts and continues.";
        await d.act(accept);
        const b = await checkBlocker(ctx, s);
        if (b) return b;
        const g = d.goalCheck ? await d.goalCheck(`Accept the developer terms: ${accept}`).catch(() => ({ done: true, missing: "" })) : { done: true, missing: "" };
        if (!g.done) throw new Error(`accepting the terms isn't finished yet: ${g.missing.slice(0, 160)}`);
        log(run, "approval", `Accepted ${run.app}'s developer terms on ${d.url()} for a test account (authorized by PROVISION_ACCEPT_TERMS).`, s.id);
        return "done";
      }
      if (s.noBrowser) { /* a decision, not browser work: don't spend browser minutes */ }
      else if (s.url) { const d = await browser(ctx); if (!d.url().startsWith("http")) await d.goto(s.url); }
      else await browser(ctx);
      pause(run, { kind: "human", step: s.id, reason: s.reason }, "handoff");
      return "pause";
    }
    case "browser": {
      // After a person cleared a wall the page has usually moved on (e.g. to "enter the emailed code").
      // Starting the step over would navigate back and meet the wall again, so check the page first.
      const resuming = run.vars[`resume:${s.id}`] === "1";
      if (resuming) {
        run.vars[`resume:${s.id}`] = "";
        const d = await browser(ctx);
        const goal = run.vars.account_exists && isSignUp(s) ? "Log in with the existing account" : `${s.title}: ${s.instruction || ""}`;
        const g = d.goalCheck ? await d.goalCheck(goal).catch(() => ({ done: false, missing: "" })) : { done: false, missing: "" };
        if (g.done) {
          await afterBrowserStep(ctx, s);
          log(run, "step", `${s.title}: done; the page moved on after the person's help, so the agent continues from there.`, s.id);
          return "done";
        }
      }
      if (run.vars.account_exists && isSignUp(s)) {
        if (run.vars.signed_in) { log(run, "step", `${s.title}: skipped, the shared account already exists.`, s.id); return "done"; }
        // Same goal, as a sign-in: the goal check and the recovery agent make sure it really happened.
        const d = await browser(ctx);
        if (s.url && (!resuming || !d.url().startsWith("http"))) await d.goto(s.url); // resume, unless the browser was replaced and is blank
        const signIn = "Log in (do not sign up: this email already has an account). If a sign-up form is showing, switch to the log-in page first. Log in with %email% and %password%.";
        const r = await d.act(signIn, await variablesFor(run, signIn));
        const b = await checkBlocker(ctx, s);
        if (b) return b;
        const g = d.goalCheck ? await d.goalCheck(`Log in with the existing account: ${signIn}`).catch(() => ({ done: r.ok, missing: "" })) : { done: r.ok, missing: r.message };
        if (!g.done) throw new Error(`signing in with the shared account isn't finished yet: ${g.missing.slice(0, 160)}`);
        run.vars.signed_in = "1";
        log(run, "step", `Signed in with the shared account instead of signing up.`, s.id);
        return "done";
      }
      if (needsApproval(run, s)) {
        pause(run, { kind: "approval", step: s.id, reason: `About to: ${s.instruction ? s.instruction.replace(/%([a-z_]+)%/g, (_, n) => (n === "password" ? "[password]" : run.vars[n] || (n === "email" ? run.identity?.email || n : n))) : s.title}` }, "approval");
        await browser(ctx);
        return "pause";
      }
      const d = await browser(ctx);
      if (s.url && (!resuming || !d.url().startsWith("http"))) await d.goto(s.url); // resume, unless the browser was replaced and is blank
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
      if (s.instruction && d.goalCheck) {
        // One act() is one action; multi-action steps (fill a form and submit) need the page to confirm.
        const g = await d.goalCheck(`${s.title}: ${s.instruction}`).catch(() => ({ done: true, missing: "" }));
        if (!g.done) throw new Error(`the step isn't finished yet: ${g.missing.slice(0, 160)}`);
      }
      await afterBrowserStep(ctx, s);
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
      const address = run.identity.email || "the agent's inbox";
      if (!mail && run.vars.account_exists && Date.now() - since > 60_000) {
        // Signing in to an existing account often sends no email at all: don't stall on it.
        run.waitingFor = undefined;
        log(run, "step", `${s.title}: no email within a minute; not needed when signing in to an existing account.`, s.id);
        return "done";
      }
      if (!mail) {
        run.waitingFor = { what: `an email from ${s.from || run.app} at ${address}`, since, until: since + EMAIL_WAIT_MS,
          hint: `If you are finishing the sign-up yourself in the live browser, use ${address}; mail to any other address can't reach the agent.` };
        if (Date.now() - since > EMAIL_WAIT_MS) {
          run.waitingFor = undefined;
          throw new Error(`no email from ${s.from || "the provider"} reached ${address} after 5 minutes. The sign-up was probably not submitted with that address: finish it in the live browser using ${address}, or confirm the email yourself`);
        }
        if (!run.vars[`waitlog:${s.id}`]) { run.vars[`waitlog:${s.id}`] = "1"; log(run, "info", `Waiting for the ${s.from || "provider"} email…`, s.id); }
        return "wait";
      }
      run.waitingFor = undefined;
      const d = await browser(ctx);
      if (s.extract === "link") {
        const link = findLink(mail, s.from);
        if (!link) throw new Error("the email had no usable link");
        await d.goto(link);
        log(run, "step", `${s.title}: opened the link from "${mail.subject.slice(0, 80)}".`, s.id);
      } else {
        const code = findCode(mail);
        if (!code) {
          // Many sign-in emails carry both a code and a magic link: the link works as well.
          const link = findLink(mail, s.from);
          if (!link) throw new Error(`the email "${mail.subject.slice(0, 60)}" had no code or sign-in link the agent could read`);
          await d.goto(link);
          log(run, "step", `${s.title}: no code the agent could read, so it opened the sign-in link from "${mail.subject.slice(0, 80)}" instead.`, s.id);
          return "done";
        }
        ctx.seen.add(code);
        if (s.then) {
          const r = await d.act(s.then, await variablesFor(run, s.then, { code }));
          if (!r.ok) throw new Error(`could not enter the code (${r.message.slice(0, 120)})`);
          // One act() is one action: the code field may need "Enter code manually" first. Ask the page.
          const g = d.goalCheck ? await d.goalCheck(`Sign in with the emailed code: ${s.then}`).catch(() => ({ done: true, missing: "" })) : { done: true, missing: "" };
          if (!g.done) throw new Error(`entering the emailed code isn't finished yet: ${g.missing.slice(0, 160)}`);
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
      try { await h(ctx); }
      catch (e) {
        // DCR that needs an initial access token, or issues only public clients: in full automation the
        // hosted browser agent creates the app in the console instead. No person needed for the switch.
        if (s.handler === "dcrRegister" && run.mode === "auto" && deps.hosted && /initial access token/i.test((e as Error).message) && !run.vars.dcr_token_tried) {
          // First, the hosted agent fetches a token the registration endpoint accepts; then this step runs again.
          insertDcrTokenStep(run, (e as Error).message);
          return "wait";
        }
        // Any other refusal (Typeform: "redirect_uri domain not allowed", DCR kept for MCP clients): the
        // console route still works, so the hosted agent creates the app there.
        if (s.handler === "dcrRegister" && run.mode === "auto" && deps.hosted && /initial access token|public client|registration failed/i.test((e as Error).message)) {
          switchToHosted(run, (e as Error).message);
          return "wait";
        }
        throw e;
      }
      return "done";
    }
    case "agent": return hostedStep(ctx, s);
    case "verify": return verifyStep(ctx, s);
    case "golive": {
      run.goLive = run.playbook.goLive;
      log(run, "step", run.goLive.needed ? `Works for testing now. Going live needs a person: ${run.goLive.summary} (${run.goLive.humanWork.join("; ")})` : `Nothing to approve: ${run.goLive.summary}`, s.id);
      return "done";
    }
  }
}

/** API keys: one read-only call with the key from the vault. No browser, no consent screen. */
async function verifyKey(ctx: Ctx, s: Step): Promise<Outcome> {
  const { run, deps } = ctx;
  const k = run.playbook.apiKey!;
  const key = await getSecret(vaultName(run.slug, run.id, "api_key"));
  if (!key) throw new Error("no API key in the vault, so there is nothing to verify");
  ctx.seen.add(key);
  run.verify = run.verify || { state: "", verifier: "" };
  try {
    const res = await deps.http(k.testUrl, { method: "GET", headers: { [k.header]: k.prefix ? `${k.prefix} ${key}` : key, accept: "application/json" } });
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || j.ok === false || j.error) throw new Error(`${res.status} ${String(j.error || j.message || "").slice(0, 100)}`);
    const picked = k.pick ? k.pick.split(".").reduce<unknown>((v, x) => (v && typeof v === "object" ? (v as Record<string, unknown>)[x] : undefined), j) : undefined;
    run.verify.who = picked !== undefined && picked !== null && picked !== "" ? String(picked) : `key accepted (HTTP ${res.status})`;
    run.verify.refresh = "not-offered";
    run.verify.at = new Date().toISOString();
    log(run, "step", `Verified: the API key works (GET ${k.testUrl} answered for "${run.verify.who}").`, s.id, ctx.seen);
  } catch (e) {
    run.vars.verify_error = `API key test call failed: ${(e as Error).message}`;
    log(run, "error", run.vars.verify_error, s.id, ctx.seen);
  }
  return "done";
}

async function verifyStep(ctx: Ctx, s: Step): Promise<Outcome> {
  const { run, deps } = ctx;
  if (run.playbook.credential === "api_key") return verifyKey(ctx, s);
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
  if (ctx.deps.hosted && run.mode === "auto") {
    // The hosted agent's browser is signed in already: it approves consent; the callback route catches the code.
    if (!run.verify) { run.verify = { state: newState(), verifier: "" }; run.public.authorizeUrl = authorizeUrl(o, clientId, run.vars.redirect_uri, run.verify.state); }
    const c = await hostedConsent(ctx, s, run.public.authorizeUrl || authorizeUrl(o, clientId, run.vars.redirect_uri, run.verify.state));
    if (c !== "code") return c;
    await markAccountExists(run);
    return finishVerify(ctx, s, run.verify.code!, clientId, secret);
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
  return finishVerify(ctx, s, code, clientId, secret);
}

/** Code in hand: exchange it, call the identity endpoint and the use-case call, test refresh. */
async function finishVerify(ctx: Ctx, s: Step, code: string, clientId: string, secret: string): Promise<Outcome> {
  const { run, deps } = ctx;
  const o = run.playbook.oauth;
  run.verify ??= { state: "", verifier: "" };
  ctx.seen.add(code);
  try {
    const t = await exchangeCode(deps.http, o, code, run.vars.redirect_uri, clientId, secret);
    ctx.seen.add(t.access); if (t.refresh) ctx.seen.add(t.refresh);
    await store(ctx, "access_token", t.access, true);
    if (t.refresh) await store(ctx, "refresh_token", t.refresh, true);
    // The identity call can be wrong in the research (e.g. a POST-only endpoint). A working use-case call
    // proves the token just as well, so a failed identity call alone doesn't fail verification.
    let idError: Error | undefined;
    try { run.verify.who = await whoami(deps.http, o, t.access); }
    catch (e) { idError = e as Error; log(run, "info", `${idError.message} Trying the use-case call instead.`, s.id, ctx.seen); }
    const tc = run.scopePlan?.testCall;
    if (tc) {
      // The use-case call: proves the scopes cover what the app will do, not only sign-in.
      const res = await deps.http(tc.url, { method: "GET", headers: { authorization: `Bearer ${t.access}`, accept: "application/json" } }).catch((e: Error) => ({ ok: false, status: 0, statusText: e.message }) as Response);
      const j = res.ok && typeof (res as Response).json === "function" ? ((await (res as Response).json().catch(() => ({}))) as Record<string, unknown>) : {};
      run.verify.useCaseOk = res.ok && j.ok !== false && !j.error;
      run.verify.useCase = run.verify.useCaseOk ? `${tc.label}: ok` : `${tc.label}: ${res.status} ${String(j.error || res.statusText || "").slice(0, 80)}`;
      log(run, run.verify.useCaseOk ? "step" : "error", `Use-case call ${tc.method} ${tc.url}: ${run.verify.useCaseOk ? "ok" : `failed (${run.verify.useCase})`}.`, s.id, ctx.seen);
      if (idError && run.verify.useCaseOk) run.verify.who = `token works (${tc.label})`;
    }
    if (idError && !run.verify.who) throw idError;
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
  /**
   * Dynamic Client Registration (RFC 7591): one POST creates the OAuth app. The client secret and the
   * registration access token go straight to the vault. Some vendors require an initial access token;
   * then this fails with that reason and the browser route is the fallback.
   */
  async dcrRegister(ctx) {
    const { run, deps } = ctx;
    const endpoint = run.dcr?.registrationEndpoint;
    if (!endpoint) throw new Error("no registration endpoint on this run");
    const body = {
      client_name: run.vars.app_name, redirect_uris: [run.vars.redirect_uri],
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
      token_endpoint_auth_method: run.playbook.oauth.clientAuth === "basic" ? "client_secret_basic" : "client_secret_post",
      scope: run.playbook.oauth.scopes.join(" "), client_uri: run.vars.dev_url,
    };
    // A token the hosted agent fetched for this endpoint (shared per vendor), with its scheme if not Bearer.
    const iat = await getSecret(vaultName(run.slug, run.id, "shared:dcr_token"));
    if (iat) ctx.seen.add(iat);
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
    if (iat) headers.authorization = `${run.vars.token_scheme || "Bearer"} ${iat}`;
    const res = await deps.http(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status === 401 || res.status === 403) throw new Error(`the registration endpoint wants an initial access token (${res.status}${j.error ? ` ${j.error}` : ""}); use the browser route for ${run.app}`);
    // Vendors put the reason in different fields (Typeform: code + description).
    if (!res.ok || !j.client_id) throw new Error(`registration failed: ${res.status} ${[j.error || j.code, j.error_description || j.description || j.message].filter(Boolean).map(String).join(": ").slice(0, 200)}`);
    if (!j.client_secret) throw new Error("the vendor registered a public client with no secret; this agent provisions confidential clients, so use the browser route");
    await store(ctx, "client_id", String(j.client_id), false);
    await store(ctx, "client_secret", String(j.client_secret), true);
    if (j.registration_access_token) await store(ctx, "registration_access_token", String(j.registration_access_token), true);
    run.public.appId = String(j.client_id);
    log(run, "step", `OAuth app registered with one API call (${endpoint}). Client ID ${j.client_id}. No console clicks.`, "dcr-register", ctx.seen);
  },
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
  if (s.kind !== "browser" && s.kind !== "capture" && s.kind !== "email") return null;
  if (process.env.PROVISION_RECOVERY === "0") return null;
  ctx.recovered ??= new Set();
  if (ctx.recovered.has(s.id) || Date.now() + 15_000 > ctx.deadline) return null;
  ctx.recovered.add(s.id);

  // Everything secret this run holds, so nothing the page shows can reach the model.
  for (const name of Object.values(run.vault)) { const v = await getSecret(name).catch(() => null); if (v) ctx.seen.add(v); }
  const driver = await browser(ctx);
  const names = new Set([...(("instruction" in s && s.instruction) || "").matchAll(/%([a-z_]+)%/g)].map((m) => m[1]));
  for (const n of ["app_name", "dev_name", "dev_url", "redirect_uri", "workspace_name", "first_name", "last_name", "company"]) names.add(n);
  if (run.identity?.email) { names.add("email"); names.add("password"); }
  if (s.kind === "email") names.add("code");
  const approved = JSON.parse(run.vars[`recovery-approved:${s.id}`] || "[]") as string[];
  log(run, "agent", `Step failed (${error}). Recovery agent takes over with the step's goal.`, s.id, ctx.seen);

  const result = await recover({
    driver, brain: deps.brain, mode: run.mode, app: run.app,
    step: s.kind === "capture"
      ? { id: s.id, title: s.title, kind: "capture", find: s.find, into: s.into }
      : s.kind === "email"
        // Same goal as the email step, in the browser: the page decides between link and code.
        ? { id: s.id, title: s.title, kind: "browser", instruction: `Finish signing in with the email ${run.app} sent to ${run.identity?.email || "the agent's inbox"}. Look at the page: if it offers to enter a code (for example an "Enter code manually" button), click that, use read_inbox_code and type %code%, then submit. Otherwise use open_inbox_link to open the sign-in link from the email.` }
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
    readInboxLink: async () => {
      if (!run.identity?.inboxId) return null;
      const mail = await waitForMail(deps.inbox, run.identity.inboxId, { since: Date.now() - 10 * 60_000, timeoutMs: deps.mock ? 10 : 20_000, pollMs: deps.mock ? 1 : 4000 });
      const link = mail ? findLink(mail, s.kind === "email" ? s.from : undefined) : null;
      if (link) ctx.seen.add(link);
      return link;
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
  if (TERMINAL.has(run.status) || run.status === "waiting_human" || run.status === "waiting_approval" || run.status === "ready") return run;
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
        // The hosted browser ended under the step (Browserbase answers 400/410): open a new one, which
        // keeps the saved cookies, and run the step once more before any recovery or hand-over.
        if (/Unknown error: (400|410)|session (has )?(ended|completed|closed)|410 Gone/i.test(msg) && !ctx.reopened?.has(s.id)) {
          (ctx.reopened ??= new Set()).add(s.id);
          await ctx.driver?.detach().catch(() => undefined);
          ctx.driver = undefined;
          if (run.browser) run.browser = { sessionId: "" };
          log(run, "info", `The browser session ended during "${s.title}" (${msg.slice(0, 80)}). Opened a new one; saved sign-ins carry over. Running the step again.`, s.id);
          continue;
        }
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
      run.status = run.verify?.who && run.verify.useCaseOk !== false ? "verified" : "needs_review";
      if (run.status === "verified" && !deps.mock) {
        // A real run proved a test account works: that beats any researched verdict.
        await saveSandbox(run.slug, { verdict: "self_serve", reason: `A run on ${new Date().toISOString().slice(0, 10)} created a working test account and verified credentials.`, quotes: run.sandbox?.quotes || [], signupUrl: run.sandbox?.signupUrl, source: "run", checkedOn: new Date().toISOString().slice(0, 10) }).catch(() => undefined);
      }
      log(run, "done", run.status === "verified"
        ? `Done. ${run.app} credentials verified against the sandbox and stored in the vault.${run.scopePlan ? "" : ` ${SIGN_IN_ONLY}: ${SIGN_IN_ONLY_WHY}`}`
        : `Finished, but the credentials are not verified${run.vars.verify_error ? `: ${run.vars.verify_error}` : run.verify?.useCaseOk === false ? `: sign-in works, but the use-case call failed (${run.verify.useCase}), so the scopes may not cover the use case` : ""}.`, undefined, ctx.seen);
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
      // Resume from the page the person left, instead of starting the step over.
      run.vars[`resume:${p.step}`] = "1";
      if (s.kind === "verify" && run.verify && !run.verify.code) { /* keep state, re-read the URL */ }
      run.steps[run.cursor].state = "todo";
      log(run, "handoff", `Person finished: ${run.steps[run.cursor].title}. Agent continues from that page.`, p.step);
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
  log(run, "secret", `${label} revealed.`);
  await saveRun(run);
  return v;
}

export const isTerminal = (r: Run) => TERMINAL.has(r.status);
