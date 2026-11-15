// Zero-touch: from an app name to verified credentials with nobody pressing anything.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRun, advance, defaultDeps, oauthFromOtherEvidence, isTermsOnly } from "../lib/provision/engine";
import { _resetRuns, getRun } from "../lib/provision/runs";
import { _resetVault } from "../lib/provision/vault";
import { _resetSandboxCache, type SandboxIo } from "../lib/provision/sandbox";
import { libraryGuides } from "../lib/library";
import { saveGuide } from "../lib/store";
import type { Run, SandboxCheck } from "../lib/provision/types";

const BASE = "https://example.test";
beforeEach(() => { process.env.PROVISION_MOCK = "1"; delete process.env.SUPABASE_URL; delete process.env.GOOGLE_SHEET_ID; delete process.env.PROVISION_INBOX_ID; _resetRuns(); _resetVault(); _resetSandboxCache(); });

/** Advances only. Any pause for a person fails the test. */
async function hands_off(id: string, deps = defaultDeps()): Promise<Run> {
  for (let i = 0; i < 60; i++) {
    const r = await advance(id, deps, 30_000);
    if (r.status === "waiting_human" || r.status === "waiting_approval") assert.fail(`asked a person: ${r.pending?.reason}`);
    if (["verified", "needs_review", "failed", "cancelled"].includes(r.status)) return r;
  }
  throw new Error("did not finish");
}

test("app name in, verified credentials out, nobody touches anything (auto-start)", async () => {
  const run = await createRun({ app: "Linear", baseUrl: BASE, autoStart: true });
  assert.equal(run.status, "queued");
  assert.equal(run.mode, "auto");
  assert.ok(run.events.some((e) => /Started full automation automatically/.test(e.text)));
  const done = await hands_off(run.id);
  assert.equal(done.status, "verified");
  assert.ok(done.vault.client_secret);
});

const unclear: SandboxIo = {
  research: async () => ({ relation: "separate", developerAccount: { name: "Ent portal" }, sandbox: { name: "Ent sandbox" }, oauthApp: { available: "unclear" } }),
  pageText: async () => "", probe: async (u) => ({ url: u, signals: [], looks: "unclear" }),
};

test("full automation doesn't stop to ask about a not-confirmed sandbox", async () => {
  const notion = libraryGuides().find((g) => g.slug === "notion")!;
  await saveGuide({ ...notion, slug: "ent", name: "Ent", website: "ent.example", evidenceLevel: "generated" });
  const deps = { ...defaultDeps(), sandboxIo: unclear };
  const run = await createRun({ app: "Ent", baseUrl: BASE, autoStart: true }, deps);
  assert.equal(run.steps[0].id, "sandbox-check");
  const done = await hands_off(run.id, deps);
  assert.ok(done.events.some((e) => /full automation tries anyway/.test(e.text)));
  assert.equal(done.status, "verified");
  // A person reading the findings still gets the question in human mode.
  const human = await createRun({ app: "Ent", baseUrl: BASE, mode: "human" }, deps);
  assert.equal((await advance(human.id, deps, 30_000)).status, "waiting_human");
});

test("the OAuth part counts the guide's self-serve steps or DCR as evidence; a 'partners only' quote still wins", () => {
  const sb = (oauthQuotes: SandboxCheck["quotes"] = []): SandboxCheck => ({ verdict: "unknown", reason: "r", quotes: [], source: "research", checkedOn: "", parts: [
    { role: "developer_account", name: "d", verdict: "self_serve", reason: "", quotes: [] },
    { role: "sandbox", name: "s", verdict: "likely_self_serve", reason: "", quotes: [] },
    { role: "oauth_app", name: "o", verdict: "unknown", reason: "", quotes: oauthQuotes },
  ] });
  const guide = libraryGuides().find((g) => g.slug === "notion")!;
  assert.equal(oauthFromOtherEvidence(sb(), { guide })?.verdict, "likely_self_serve");
  assert.equal(oauthFromOtherEvidence(sb(), { dcr: { available: true } })?.verdict, "likely_self_serve");
  assert.equal(oauthFromOtherEvidence(sb(), {})?.verdict, "unknown");
  assert.equal(oauthFromOtherEvidence(sb([{ quote: "partners only", url: "u", says: "no", found: true }]), { guide })?.verdict, "unknown");
});

test("only developer terms are accepted automatically; payment, phone and identity checks never are", () => {
  const h = (title: string, reason = "") => ({ kind: "human" as const, id: "x", title, reason });
  assert.ok(isTermsOnly(h("Accept the developer terms")));
  assert.ok(isTermsOnly(h("Sign the Acceptable Use Policy")));
  assert.ok(!isTermsOnly(h("Accept terms and add a payment card")));
  assert.ok(!isTermsOnly(h("Verify your phone number", "Enter the SMS code")));
  assert.ok(!isTermsOnly(h("Business verification", "Upload an ID document")));
  assert.ok(!isTermsOnly(h("Sign in", "Sign in to your workspace")));
});

test("no guide needed: the sandbox research's brief is enough to plan and run, and nothing is saved to the Library", async () => {
  const { getGuide } = await import("../lib/store");
  const withBrief: SandboxIo = {
    research: async () => ({
      summary: "Free developer account; apps are created in the developer console.",
      relation: "same",
      developerAccount: { name: "Brief portal", signupUrl: "https://briefco.example/signup", quotes: [{ quote: "Sign up free for a developer account", url: "https://briefco.example/dev", says: "yes" }] },
      oauthApp: { available: "self_serve", quotes: [{ quote: "Any developer can create an OAuth app", url: "https://briefco.example/dev", says: "yes" }] },
      resources: {
        website: "briefco.example",
        docs: [{ label: "Create an OAuth app", url: "https://briefco.example/docs/oauth" }, { label: "bad", url: "javascript:alert(1)" }],
        steps: [{ title: "Sign up for a developer account", detail: "Use the sign-up form", owner: "agent" }, { title: "Create an OAuth app", detail: "Developer console > New app", owner: "agent" }],
        oauth: { authorizeUrl: "https://briefco.example/oauth/authorize", tokenUrl: "https://briefco.example/oauth/token", identity: { url: "https://api.briefco.example/me", pick: "id" }, scopes: ["read"] },
      },
    }),
    pageText: async () => "Sign up free for a developer account. Any developer can create an OAuth app.",
    probe: async (u) => ({ url: u, signals: ["password field"], looks: "signup_form" }),
  };
  const deps = { ...defaultDeps(), sandboxIo: withBrief };
  const run = await createRun({ app: "BriefCo", baseUrl: BASE, autoStart: true }, deps);
  assert.ok(run.sandbox?.resources);
  assert.deepEqual(run.sandbox!.resources!.docs.map((d) => d.label), ["Create an OAuth app"], "the bad URL was dropped");
  assert.equal(await getGuide("briefco"), null, "no guide written or saved");
  assert.equal((await hands_off(run.id, deps)).status, "verified");
});

test("without a usable brief, a vendor with no guide still falls back to writing the full guide", async () => {
  const { NoGuideError } = await import("../lib/provision/engine");
  const deps = { ...defaultDeps(), sandboxIo: { ...unclear, research: async () => ({ relation: "same", developerAccount: { name: "x", quotes: [{ quote: "Free developer accounts for everyone", url: "https://nobrief.example", says: "yes" as const }] }, oauthApp: { available: "self_serve" }, resources: { docs: [], steps: [] } }), pageText: async () => "Free developer accounts for everyone" } };
  await assert.rejects(createRun({ app: "NoBriefCo", baseUrl: BASE, autoStart: true }, deps), NoGuideError);
});

test("in full automation a sign-in or sign-up form is not handed over: the agent has its own login", async () => {
  // The live Linear run: the sign-up page (email field, 'Continue with email') was read as "wants you to sign in".
  process.env.PROVISION_MOCK_BLOCKER = "signin";
  try {
    const run = await createRun({ app: "Linear", baseUrl: BASE, autoStart: true });
    const done = await hands_off(run.id);
    assert.equal(done.status, "verified");
  } finally { delete process.env.PROVISION_MOCK_BLOCKER; }
});

test("after a person clears a captcha the step continues from that page; it is not started over (the Linear loop)", async () => {
  const { respond } = await import("../lib/provision/engine");
  process.env.PROVISION_MOCK_BLOCKER = "captcha";
  try {
    const run = await createRun({ app: "Linear", baseUrl: BASE, autoStart: true });
    let r = await advance(run.id, defaultDeps(), 30_000);
    assert.equal(r.status, "waiting_human");
    assert.equal(r.pending?.blocker, "captcha");
    r = await respond(run.id, "continue");
    assert.ok(r.events.some((e) => /Agent continues from that page/.test(e.text)));
    const done = await hands_off(run.id);
    assert.ok(done.events.some((e) => /the page moved on after the person's help/.test(e.text)), "resumed instead of restarting");
    assert.equal(done.events.filter((e) => e.kind === "handoff" && /captcha/i.test(e.text)).length, 1, "one hand-over, no loop");
    assert.equal(done.status, "verified");
  } finally { delete process.env.PROVISION_MOCK_BLOCKER; }
});

const linearMail = (text: string) => ({
  async create(u: string) { return { inboxId: `${u}@agentmail.to`, email: `${u}@agentmail.to` }; },
  async get(id: string) { return { inboxId: id, email: id }; },
  async list() { return [{ id: "m1", from: "Linear <noreply@linear.app>", subject: "Login for Linear", text, html: "", at: new Date().toISOString() }]; },
});

test("Linear's real login email: the 10-character code is found, typed, and the run verifies hands-off", async () => {
  const deps = { ...defaultDeps(), inbox: linearMail("Click the link to log in: https://linear.app/auth/abc. If you can't click on the link, you can also copy the verification code into your browser: Q7KD2MX9PA") };
  const run = await createRun({ app: "Linear", baseUrl: BASE, autoStart: true }, deps);
  const done = await hands_off(run.id, deps);
  assert.ok(done.events.some((e) => /code read from "Login for Linear" and entered/.test(e.text)));
  assert.ok(!JSON.stringify(done.events).includes("Q7KD2MX9PA"), "the code never appears in the log");
  assert.equal(done.status, "verified");
});

test("an email with a sign-in link but no readable code: the agent opens the link instead of handing over", async () => {
  const deps = { ...defaultDeps(), inbox: linearMail("Click the link to log in: https://linear.app/auth/magic-token-123") };
  const done = await hands_off((await createRun({ app: "Linear", baseUrl: BASE, autoStart: true }, deps)).id, deps);
  assert.ok(done.events.some((e) => /opened the sign-in link/.test(e.text)));
  assert.equal(done.status, "verified");
});

test("an email the step can't use goes to the recovery agent, which looks at the page and chooses", async () => {
  const deps = { ...defaultDeps(), inbox: linearMail("Welcome to Linear! We're glad you're here.") };
  const done = await hands_off((await createRun({ app: "Linear", baseUrl: BASE, autoStart: true }, deps)).id, deps);
  assert.ok(done.events.some((e) => e.step === "login-code" && /Recovery agent takes over/.test(e.text)));
  assert.ok(done.steps.find((s) => s.id === "login-code")?.recovered);
  assert.equal(done.status, "verified");
});

test("the recovery agent can open the email's sign-in link when there is an inbox", async () => {
  const { toolsFor } = await import("../lib/provision/recover");
  const names = toolsFor({ captureLabels: [], hasInbox: true, readInboxLink: async () => null }).map((t) => t.name);
  assert.ok(names.includes("read_inbox_code") && names.includes("open_inbox_link"));
  assert.ok(!toolsFor({ captureLabels: [], hasInbox: false }).map((t) => t.name).includes("open_inbox_link"));
});

test("HubSpot sign-up is one screen per step (email first), and the plan is still valid", async () => {
  const { PLAYBOOKS, validatePlaybook } = await import("../lib/provision/planner");
  const hs = PLAYBOOKS.hubspot;
  assert.deepEqual(validatePlaybook(hs), []);
  const auto = hs.steps.auto.map((s) => s.id);
  assert.deepEqual(auto.slice(0, 5), ["identity", "signup", "verify-email", "details", "finish-signup"]);
  const signup = hs.steps.auto.find((s) => s.id === "signup") as { instruction: string };
  assert.ok(!/first name|last name/i.test(signup.instruction), "the email screen asks only for the email");
  assert.equal((await hands_off((await createRun({ app: "HubSpot", baseUrl: BASE, autoStart: true })).id)).status, "verified");
});

test("the recovery agent is told to read filled fields and error messages before typing again", async () => {
  const { SYSTEM } = await import("../lib/provision/recover");
  assert.match(SYSTEM, /fields are filled/);
  assert.match(SYSTEM, /Please enter a valid email address/);
  assert.match(SYSTEM, /Typing replaces/);
});

test("a browser that dies under a step (Browserbase 400) is replaced and the step runs again, hands-off", async () => {
  const base = defaultDeps();
  let killed = false;
  const deps = { ...base, openBrowser: async (o: { sessionId?: string; contextId?: string; mockFail?: string }) => {
    const d = await base.openBrowser(o);
    return { ...d, act: async (instruction: string, variables?: Record<string, string>) => {
      if (!killed && /sign-up|signup|%email%/i.test(instruction)) { killed = true; throw new Error("Unknown error: 400"); }
      return d.act(instruction, variables);
    } };
  } };
  const run = await createRun({ app: "Linear", baseUrl: BASE, autoStart: true }, deps);
  const done = await hands_off(run.id, deps);
  assert.ok(killed);
  assert.ok(done.events.some((e) => /The browser session ended during/.test(e.text)));
  assert.equal(done.status, "verified");
});

test("sign-up forms get name and company values, and the recovery agent knows disabled buttons and dropdowns", async () => {
  const { SYSTEM } = await import("../lib/provision/recover");
  assert.match(SYSTEM, /greyed-out \(disabled\) submit button/);
  assert.match(SYSTEM, /Custom dropdowns take two actions/);
  const run = await createRun({ app: "Linear", baseUrl: BASE });
  assert.equal(run.vars.first_name, "Toolkit");
  assert.equal(run.vars.last_name, "Agent");
  assert.equal(run.vars.company, "Toolkit Test");
});
