// Step one of provisioning: is a self-serve test setup possible? Developer side, sandbox and OAuth
// availability are judged separately, only quotes found on their pages count, and only quoted
// evidence of a gate stops a run. Offline: research, pages and probes are injected.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { combine, quoteOnPage, classifyPage, checkSandbox, weakest, _resetSandboxCache, type SandboxIo, type Found } from "../lib/provision/sandbox";
import { safeTestCall } from "../lib/provision/scopes";
import { createRun, advance, respond, defaultDeps, SandboxGatedError } from "../lib/provision/engine";
import { PLAYBOOKS } from "../lib/provision/planner";
import { _resetRuns, getRun } from "../lib/provision/runs";
import { _resetVault } from "../lib/provision/vault";
import { libraryGuides } from "../lib/library";
import { saveGuide } from "../lib/store";
import type { Run, SetupPart } from "../lib/provision/types";

const BASE = "https://example.test";

beforeEach(() => {
  process.env.PROVISION_MOCK = "1";
  delete process.env.SUPABASE_URL;
  delete process.env.GOOGLE_SHEET_ID;
  _resetRuns(); _resetVault(); _resetSandboxCache();
});

const q = (says: "yes" | "no", found = true) => ({ quote: "x", url: "https://v.example/p", says, found });

test("combine: only found quotes count, and a gate needs a quote", () => {
  assert.equal(combine([q("no")], undefined).verdict, "gated");
  assert.equal(combine([q("no", false)], undefined).verdict, "unknown");
  assert.equal(combine([q("yes"), q("no")], undefined).verdict, "unknown");
  assert.equal(combine([q("yes")], { url: "u", signals: [], looks: "signup_form" }).verdict, "self_serve");
  assert.equal(combine([q("yes")], { url: "u", signals: [], looks: "sales_gate" }).verdict, "unknown");
  assert.equal(combine([q("yes")], undefined).verdict, "likely_self_serve");
  // A sales-looking page alone is not enough to block.
  assert.equal(combine([], { url: "u", signals: [], looks: "sales_gate" }).verdict, "unknown");
  assert.equal(weakest([{ verdict: "self_serve" }, { verdict: "gated" }, { verdict: "unknown" }] as SetupPart[]), "gated");
});

test("quotes must really be on the page; trimmed quotes still match", () => {
  const page = "<p>Join the Slack Developer Program to get a free sandbox workspace with Enterprise features for testing apps.</p>";
  assert.ok(quoteOnPage("Join the Slack Developer Program to get a free sandbox workspace", page));
  assert.ok(quoteOnPage("…to get a free sandbox workspace with Enterprise features for testing apps and more", page));
  assert.ok(!quoteOnPage("Anyone can create a free developer account in seconds", page));
});

test("sign-up page probe: a form beats a 'Contact sales' link; a demo form alone looks gated", () => {
  assert.equal(classifyPage('<form><input type="email"><input type="password"></form><a>Contact sales</a>', true).looks, "signup_form");
  assert.equal(classifyPage("<h1>Request a demo</h1><p>Talk to sales about pricing</p>", true).looks, "sales_gate");
  assert.equal(classifyPage("<h1>Welcome</h1>", true).looks, "unclear");
});

const io = (found: Found, pages: Record<string, string>, looks: Record<string, "signup_form" | "sales_gate" | "unclear"> = {}): SandboxIo => ({
  research: async () => found,
  pageText: async (u) => pages[u] || "",
  probe: async (u) => ({ url: u, signals: [], looks: looks[u] || "unclear" }),
});

test("Slack-like: separate sandbox, each part judged on its own quotes and sign-up page", async () => {
  const r = await checkSandbox({ name: "Chat", slug: "chat" }, io({
    relation: "separate",
    developerAccount: { name: "Chat account at api.chat.example", signupUrl: "https://api.chat.example/signup", quotes: [{ quote: "Create your first app in minutes with a free account", url: "https://api.chat.example/docs", says: "yes" }] },
    sandbox: { name: "Developer sandbox workspace", signupUrl: "https://chat.example/developer-program", quotes: [{ quote: "Members get free sandbox workspaces for testing", url: "https://chat.example/developer-program", says: "yes" }] },
    oauthApp: { available: "self_serve", quotes: [{ quote: "Any developer can distribute an OAuth app", url: "https://api.chat.example/docs", says: "yes" }] },
  }, {
    "https://api.chat.example/docs": "Create your first app in minutes with a free account. Any developer can distribute an OAuth app.",
    "https://chat.example/developer-program": "Members get free sandbox workspaces for testing.",
  }, { "https://api.chat.example/signup": "signup_form", "https://chat.example/developer-program": "signup_form" }));
  assert.equal(r.relation, "separate");
  assert.deepEqual(r.parts!.map((p) => [p.role, p.verdict]), [["developer_account", "self_serve"], ["sandbox", "self_serve"], ["oauth_app", "likely_self_serve"]]);
  assert.equal(r.verdict, "likely_self_serve");
  assert.match(r.reason, /a separate account/);
});

test("BambooHR-like: account is self-serve but OAuth is partner-only, so the run is gated with the API-key note", async () => {
  const r = await checkSandbox({ name: "HRApp", slug: "hrapp" }, io({
    relation: "same",
    developerAccount: { name: "HRApp company account", signupUrl: "https://hr.example/trial", quotes: [{ quote: "Start your free 7-day trial today", url: "https://hr.example/trial", says: "yes" }] },
    sandbox: { name: "Trial company", expires: "7-day trial" },
    oauthApp: { available: "partner_only", apiKeySelfServe: true, humanPath: "Apply to the marketplace partner programme.", quotes: [{ quote: "OAuth is available to approved marketplace partners only", url: "https://hr.example/api", says: "no" }] },
  }, {
    "https://hr.example/trial": "Start your free 7-day trial today.",
    "https://hr.example/api": "Generate an API key from your account. OAuth is available to approved marketplace partners only.",
  }, { "https://hr.example/trial": "signup_form" }));
  assert.equal(r.verdict, "gated");
  assert.equal(r.parts!.find((p) => p.role === "sandbox")!.expires, "7-day trial");
  assert.equal(r.credential?.apiKey, true);
  assert.match(r.reason, /OAuth app.*API key is self-serve/);
  assert.match(r.humanPath || "", /partner programme/);
});

test("invented quotes are thrown away, so the person decides instead of the model", async () => {
  const r = await checkSandbox({ name: "Ent", slug: "ent" }, io({
    relation: "separate",
    developerAccount: { name: "Ent developer portal", quotes: [{ quote: "Sandboxes are only for customers on Enterprise plans", url: "https://ent.example/dev", says: "no" }] },
    sandbox: { name: "Ent sandbox" },
    oauthApp: { available: "unclear" },
  }, { "https://ent.example/dev": "Welcome to the Ent developer portal." }));
  assert.notEqual(r.verdict, "gated");
  assert.equal(r.verdict, "unknown");
  assert.ok(r.quotes.every((x) => !x.found));
});

async function guideFor(slug: string, name: string) {
  const notion = libraryGuides().find((g) => g.slug === "notion")!;
  await saveGuide({ ...notion, slug, name, website: `${slug}.example`, evidenceLevel: "generated" });
}

test("a gated vendor stops before any plan, browser or sign-up", async () => {
  await guideFor("hrapp", "HRApp");
  const deps = { ...defaultDeps(), sandboxIo: io({ relation: "same", developerAccount: { name: "x", quotes: [{ quote: "Contact our sales team to get a sandbox", url: "https://hr.example/s", says: "no" }] }, oauthApp: { available: "partner_only" } }, { "https://hr.example/s": "Contact our sales team to get a sandbox." }) };
  await assert.rejects(createRun({ app: "HRApp", mode: "auto", baseUrl: BASE }, deps), (e: unknown) => e instanceof SandboxGatedError && e.check.verdict === "gated");
});

test("an unconfirmed vendor gets a decision step first, which opens no browser", async () => {
  await guideFor("ent", "Ent");
  const deps = { ...defaultDeps(), sandboxIo: io({ relation: "separate", developerAccount: { name: "Ent portal" }, sandbox: { name: "Ent sandbox" }, oauthApp: { available: "unclear" } }, {}) };
  const run = await createRun({ app: "Ent", mode: "human", baseUrl: BASE }, deps);
  assert.equal(run.steps[0].id, "sandbox-check");
  const r = await advance(run.id, deps, 30_000);
  assert.equal(r.status, "waiting_human");
  assert.equal(r.pending?.step, "sandbox-check");
  assert.equal(r.browser, undefined);
  assert.equal((await respond(run.id, "cancel")).status, "cancelled");
});

test("hand-written playbooks know whether the sandbox is a separate account", async () => {
  const slack = await createRun({ app: "Slack", mode: "human", baseUrl: BASE });
  assert.equal(slack.sandbox?.relation, "separate");
  const linear = await createRun({ app: "Linear", mode: "human", baseUrl: BASE });
  assert.equal(linear.sandbox?.relation, "same");
  assert.equal(linear.sandbox?.verdict, "self_serve");
});

test("use case: the test call must be a GET to the vendor's own API", () => {
  const p = PLAYBOOKS.linear;
  assert.ok(safeTestCall(p, { method: "GET", url: "https://api.linear.app/graphql?query=x", label: "issues" }));
  assert.equal(safeTestCall(p, { method: "POST", url: "https://api.linear.app/graphql" }), undefined);
  assert.equal(safeTestCall(p, { method: "GET", url: "https://evil.example/collect" }), undefined);
  assert.equal(safeTestCall(p, { method: "GET", url: "https://api.linear.app/teams/{id}" }), undefined);
});

test("use case: scopes and the test call land on the run, and a failing test call means needs review", async () => {
  const run = await createRun({ app: "Linear", mode: "auto", baseUrl: BASE, useCase: "read issues" });
  assert.equal(run.scopePlan?.useCase, "read issues");
  assert.ok(run.scopePlan?.testCall);
  // Make the use-case call fail with 403, as it would with a missing scope.
  const base = defaultDeps();
  const url = run.scopePlan!.testCall!.url;
  let calls = 0;
  const deps = { ...base, http: async (u: string, init?: RequestInit) => {
    if (u === url && (init?.method || "GET") === "GET" && !(init?.headers && JSON.stringify(init.headers).includes("content-type")) ) { calls++; return new Response(JSON.stringify({ error: "insufficient_scope" }), { status: 403 }); }
    return base.http(u, init);
  } };
  let r: Run = run;
  for (let i = 0; i < 60 && !["verified", "needs_review", "failed", "cancelled"].includes(r.status); i++) {
    r = await advance(run.id, deps, 30_000);
    if (r.status === "waiting_human" || r.status === "waiting_approval") r = await respond(run.id, r.status === "waiting_approval" ? "approve" : "continue");
  }
  assert.ok(calls >= 1);
  const done = (await getRun(run.id))!;
  assert.equal(done.verify?.useCaseOk, false);
  assert.equal(done.status, "needs_review");
});
