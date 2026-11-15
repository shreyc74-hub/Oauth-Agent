// The research-first flow: credentials offered -> credential chosen -> creation route -> recommended
// mode, then the person chooses the mode and starts. Offline: research, pages and probes are injected.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { offeredCredentials, chooseCredential, chooseRoute } from "../lib/provision/assess";
import { createRun, startRun, advance, respond, defaultDeps } from "../lib/provision/engine";
import { _resetRuns, getRun } from "../lib/provision/runs";
import { _resetVault, getSecret } from "../lib/provision/vault";
import { _resetSandboxCache, type SandboxIo } from "../lib/provision/sandbox";
import { libraryGuides } from "../lib/library";
import { saveGuide } from "../lib/store";
import type { Run, SandboxCheck } from "../lib/provision/types";

const BASE = "https://example.test";
beforeEach(() => { process.env.PROVISION_MOCK = "1"; delete process.env.SUPABASE_URL; delete process.env.GOOGLE_SHEET_ID; _resetRuns(); _resetVault(); _resetSandboxCache(); });

async function guideFor(slug: string, name: string) {
  const notion = libraryGuides().find((g) => g.slug === "notion")!;
  await saveGuide({ ...notion, slug, name, website: `${slug}.example`, evidenceLevel: "generated" });
}
async function drive(id: string, deps = defaultDeps()) {
  let r = (await getRun(id))!;
  for (let i = 0; i < 60 && !["verified", "needs_review", "failed", "cancelled"].includes(r.status); i++) {
    r = await advance(id, deps, 30_000);
    if (r.status === "waiting_human" || r.status === "waiting_approval") r = await respond(id, r.status === "waiting_approval" ? "approve" : "continue");
  }
  return (await getRun(id))!;
}

const found = (o: Partial<SandboxCheck>): SandboxCheck => ({ verdict: "self_serve", reason: "", quotes: [], source: "research", checkedOn: "", ...o });
const q = (quote: string) => ({ quote, url: "https://v.example/docs", found: true });

test("credentials come from the vendor's own pages, not from an existing Composio toolkit", () => {
  // A vendor no catalogue knows: only what the agent found.
  const sb = found({ offered: [{ type: "oauth2", selfServe: "yes", quote: q("Register an OAuth app") }, { type: "api_key", where: "Settings > API", selfServe: "yes", quote: q("Create a personal API key") }] });
  const offered = offeredCredentials({ sandbox: sb });
  assert.deepEqual(offered.map((o) => o.type).sort(), ["api_key", "oauth2"]);
  assert.ok(offered.every((o) => /vendor docs/.test(o.source)));
  assert.equal(chooseCredential(offered, sb).chosen, "oauth");
});

test("credential choice: OAuth when self-serve, otherwise an API key", () => {
  const gated = found({ credential: { oauth: "partner_only", apiKey: true }, offered: [{ type: "oauth2", selfServe: "no" }, { type: "api_key", selfServe: "yes", quote: q("Generate an API key") }] });
  const r = chooseCredential(offeredCredentials({ sandbox: gated }), gated);
  assert.equal(r.chosen, "api_key");
  assert.match(r.why, /partners/);
  const keyOnly = found({ offered: [{ type: "api_key", selfServe: "yes" }] });
  assert.equal(chooseCredential(offeredCredentials({ sandbox: keyOnly }), keyOnly).chosen, "api_key");
});

test("route: DCR on the main server beats the browser; a documented API found by research is named as the better route", () => {
  const dcr = { available: true, kind: "api" as const, registrationEndpoint: "https://v.example/register", found: [], checked: 1, checkedOn: "" };
  assert.equal(chooseRoute({ chosen: "oauth", dcr }).method, "Dynamic Client Registration");
  assert.equal(chooseRoute({ chosen: "oauth", dcr: { ...dcr, kind: "mcp" } }).method, "Browser automation");
  const viaApi = chooseRoute({ chosen: "oauth", sandbox: found({ creation: { kind: "management_api", detail: "POST /v1/oauth/apps", quote: q("Create OAuth apps with POST /v1/oauth/apps") } }) });
  assert.equal(viaApi.method, "Browser automation");
  assert.match(viaApi.fallback || "", /Management API \(POST \/v1\/oauth\/apps\)/);
  assert.equal(chooseRoute({ chosen: "api_key" }).method, "API key from the dashboard");
});

test("research first: a run without a mode stops at ready with an assessment, and only starts when a person picks the mode", async () => {
  const run = await createRun({ app: "Linear", baseUrl: BASE });
  assert.equal(run.status, "ready");
  assert.ok(run.assessment);
  assert.equal(run.assessment!.credentials.chosen, "oauth");
  assert.equal(run.assessment!.accounts.relation, "same");
  assert.equal((await advance(run.id, defaultDeps(), 5_000)).status, "ready", "a ready run never runs by itself");
  const started = await startRun(run.id, "human");
  assert.equal(started.status, "queued");
  assert.equal(started.mode, "human");
  assert.equal(started.steps[0].kind, "human");
  await assert.rejects(startRun(run.id, "auto"), /already started/);
  assert.equal((await drive(run.id)).status, "verified");
});

test("the recommendation: a tested plan with both modes available recommends full automation; a generated plan recommends a person", async () => {
  assert.equal((await createRun({ app: "Linear", baseUrl: BASE })).assessment!.recommendedMode, "auto");
  await guideFor("vendorx", "VendorX");
  const gen = await createRun({ app: "VendorX", baseUrl: BASE });
  assert.equal(gen.assessment!.recommendedMode, "human");
  assert.match(gen.assessment!.recommendWhy, /generated/);
});

const keyOnly: SandboxIo = {
  research: async () => ({
    relation: "same",
    developerAccount: { name: "HRApp company account", signupUrl: "https://hr.example/trial", quotes: [{ quote: "Start your free trial today", url: "https://hr.example/trial", says: "yes" }] },
    sandbox: { name: "Trial company" },
    oauthApp: { available: "partner_only", apiKeySelfServe: true, quotes: [{ quote: "OAuth is for approved partners only", url: "https://hr.example/api", says: "no" }] },
    credentials: [{ type: "api_key", where: "Account > API Keys", selfServe: "yes", quote: { quote: "Generate an API key from your account", url: "https://hr.example/api", says: "yes" } }],
  }),
  pageText: async (u) => ({ "https://hr.example/trial": "Start your free trial today.", "https://hr.example/api": "Generate an API key from your account. OAuth is for approved partners only." } as Record<string, string>)[u] || "",
  probe: async (u) => ({ url: u, signals: ["password field"], looks: "signup_form" }),
};

test("API-key vendor: plans an API key, creates it into the vault, and verifies it with one call", async () => {
  await guideFor("hrapp", "HRApp");
  const deps = { ...defaultDeps(), sandboxIo: keyOnly };
  const run = await createRun({ app: "HRApp", baseUrl: BASE }, deps);
  assert.equal(run.assessment!.credentials.chosen, "api_key");
  assert.equal(run.assessment!.route.method, "API key from the dashboard");
  assert.equal(run.playbook.credential, "api_key");
  assert.ok(run.playbook.steps.human.some((s) => s.kind === "capture" && s.into === "api_key"));
  await startRun(run.id, "human");
  let sent = "";
  const http = async (u: string, init?: RequestInit) => {
    if (u === run.playbook.apiKey!.testUrl) { sent = JSON.stringify(init?.headers || {}); return new Response(JSON.stringify({ id: "company-42" }), { status: 200 }); }
    return deps.http(u, init);
  };
  const done = await drive(run.id, { ...deps, http });
  const key = await getSecret(done.vault.api_key);
  assert.ok(key);
  assert.ok(sent.includes(key!), "the test call carried the key from the vault");
  assert.equal(done.status, "verified");
  assert.equal(done.verify?.who, "company-42");
  assert.ok(!JSON.stringify(done).includes(key!), "the key is not in the run record");
});

test("DCR vendor: the OAuth app is registered with one API call, then verified", async () => {
  await guideFor("dcrapp", "DcrApp");
  const meta = { issuer: "https://dcrapp.example", authorization_endpoint: "https://dcrapp.example/oauth/authorize", token_endpoint: "https://dcrapp.example/oauth/token", registration_endpoint: "https://dcrapp.example/oauth/register" };
  const deps = { ...defaultDeps(), dcrFetch: async (u: string) => (u === "https://dcrapp.example/.well-known/oauth-authorization-server" ? meta : null) };
  const run = await createRun({ app: "DcrApp", baseUrl: BASE }, deps);
  assert.equal(run.assessment!.route.method, "Dynamic Client Registration");
  assert.equal(run.playbook.strategy, "dcr");
  assert.equal(run.playbook.oauth.tokenUrl, meta.token_endpoint);
  await startRun(run.id, "human");
  const done: Run = await drive(run.id, deps);
  assert.ok(done.events.some((e) => /registered with one API call/.test(e.text)));
  assert.ok(await getSecret(done.vault.client_secret));
  assert.ok(done.vault.registration_access_token);
  assert.equal(done.status, "verified");
});
