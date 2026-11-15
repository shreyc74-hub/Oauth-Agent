// Provisioning: playbooks, the run state machine (handoffs, approvals, retries), the vault boundary,
// verification, and the routes' access rules. Runs offline with the mock browser, inbox and APIs.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { PLAYBOOKS, validatePlaybook, mockPlanFromGuide } from "../lib/provision/planner";
import { createRun, advance, respond, reveal, NoGuideError, defaultDeps } from "../lib/provision/engine";
import { getRun, attachCode, _resetRuns } from "../lib/provision/runs";
import { getSecret, mask, redact, vaultName, _resetVault, putSecret } from "../lib/provision/vault";
import { totp, seedFrom } from "../lib/provision/totp";
import { findCode, findLink } from "../lib/provision/inbox";
import { authorizeUrl, codeFromUrl } from "../lib/provision/verify";
import { rowFor } from "../lib/provision/sheets";
import { libraryGuides } from "../lib/library";
import { saveGuide } from "../lib/store";
import type { Run } from "../lib/provision/types";
import { POST as createRoute } from "../app/api/provision/route";
import { POST as revealRoute } from "../app/api/provision/[id]/reveal/route";
import { gate } from "../lib/provision/http";

const BASE = "https://example.test";

beforeEach(() => {
  process.env.PROVISION_MOCK = "1";
  delete process.env.PROVISION_MOCK_BLOCKER;
  delete process.env.PROVISION_MOCK_RECOVERY;
  delete process.env.PROVISION_RECOVERY;
  delete process.env.SUPABASE_URL;
  delete process.env.GOOGLE_SHEET_ID;
  _resetRuns(); _resetVault();
});

/** Drives a run to the end, answering every pause like a person would. */
async function drive(id: string, answer: (r: Run) => Parameters<typeof respond>[1] = (r) => (r.status === "waiting_approval" ? "approve" : "continue")) {
  for (let i = 0; i < 60; i++) {
    let r = await advance(id, defaultDeps(), 30_000);
    if (["verified", "needs_review", "failed", "cancelled"].includes(r.status)) return r;
    if (r.status === "waiting_human" || r.status === "waiting_approval") r = await respond(id, answer(r));
  }
  throw new Error("run did not finish");
}

test("hand-written playbooks pass the structural checks", () => {
  for (const p of Object.values(PLAYBOOKS)) assert.deepEqual(validatePlaybook(p), [], p.slug);
});

test("checks catch unsafe or incomplete plans", () => {
  const bad = structuredClone(PLAYBOOKS.linear);
  bad.steps.human = bad.steps.human.filter((s) => s.id !== "client-secret");
  (bad.steps.human[1] as { instruction?: string }).instruction = "Paste the client secret into the box";
  bad.steps.human.unshift({ kind: "identity", id: "identity2", title: "x" });
  const errs = validatePlaybook(bad).join(" | ");
  assert.match(errs, /client_secret/);
  assert.match(errs, /%variable%/);
  assert.match(errs, /must not create an agent identity/);
});

test("TOTP matches the RFC 6238 test vector", () => {
  assert.equal(totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 59_000), "287082");
  assert.equal(seedFrom("otpauth://totp/X:me?secret=JBSW Y3DP&issuer=X"), "JBSWY3DP");
});

test("codes and links are read from emails without the model", () => {
  assert.equal(findCode({ subject: "Welcome", text: "Your Linear login code is 123-ABC. It expires soon.", html: "" }), "123-ABC");
  assert.equal(findCode({ subject: "Slack confirmation code: 482913", text: "", html: "" }), "482913");
  assert.equal(findLink({ text: "Unsubscribe https://x.com/unsubscribe?u=1 Verify: https://app.hubspot.com/verify?token=abc", html: "" }, "hubspot"), "https://app.hubspot.com/verify?token=abc");
});

test("authorize URL and callback state check", () => {
  const url = authorizeUrl(PLAYBOOKS.linear.oauth, "cid", `${BASE}/api/oauth/callback`, "st8");
  const u = new URL(url);
  assert.equal(u.searchParams.get("scope"), "read,write,issues:create");
  assert.equal(u.searchParams.get("prompt"), "consent");
  assert.equal(codeFromUrl(`${BASE}/api/oauth/callback?code=abc&state=st8`, "st8"), "abc");
  assert.equal(codeFromUrl(`${BASE}/api/oauth/callback?code=abc&state=other`, "st8"), null, "wrong state is rejected");
});

test("full automation: Linear end to end, secrets only in the vault", async () => {
  const run = await createRun({ app: "Linear", mode: "auto", baseUrl: BASE });
  assert.equal(run.status, "queued");
  const done = await drive(run.id);
  assert.equal(done.status, "verified");
  assert.equal(done.verify?.who, "Mock Sandbox");
  assert.equal(done.verify?.refresh, "ok");
  assert.match(done.identity!.email!, /@agentmail\.to$/);
  assert.equal(done.events.filter((e) => e.kind === "approval").length, 0, "no approvals in auto mode");
  const secret = await getSecret(done.vault.client_secret);
  assert.ok(secret?.startsWith("mock_secret_"));
  const stored = JSON.stringify(done);
  for (const label of ["client_secret", "password", "access_token", "refresh_token"]) {
    const v = await getSecret(done.vault[label]);
    assert.ok(v && !stored.includes(v), `${label} value must not appear in the run record`);
  }
  assert.equal(done.goLive?.needed, false);
});

test("human in the loop: sign-in handoff and an approval before every write", async () => {
  const run = await createRun({ app: "linear", mode: "human", baseUrl: BASE });
  let r = await advance(run.id, defaultDeps(), 30_000);
  assert.equal(r.status, "waiting_human");
  assert.equal(r.pending?.step, "sign-in");
  assert.ok(r.browser?.liveUrl, "live view link for the person");
  r = await respond(run.id, "continue");
  r = await advance(run.id, defaultDeps(), 30_000);
  assert.equal(r.status, "waiting_approval");
  assert.equal(r.pending?.step, "create");
  assert.match(r.pending!.reason, /Click the Create button/);
  const done = await drive(run.id);
  assert.equal(done.status, "verified");
  const approved = done.events.filter((e) => e.kind === "approval" && e.text.startsWith("Approved")).map((e) => e.step);
  assert.deepEqual(approved, ["create", "verify"]);
  assert.equal(done.identity, undefined, "no agent identity in human mode");
});

test("a captcha becomes a handoff, then the agent retries the same step", async () => {
  process.env.PROVISION_MOCK_BLOCKER = "captcha";
  const run = await createRun({ app: "Linear", mode: "auto", baseUrl: BASE });
  const r = await advance(run.id, defaultDeps(), 30_000);
  assert.equal(r.status, "waiting_human");
  assert.equal(r.pending?.blocker, "captcha");
  assert.equal(r.pending?.step, "signup");
  await respond(run.id, "continue");
  const after = await getRun(run.id);
  assert.equal(after!.cursor, r.cursor, "same step runs again after the person clears the wall");
  assert.equal((await drive(run.id)).status, "verified");
});

test("Slack uses the manifest API, and the config token is bootstrapped only once", async () => {
  const first = await drive((await createRun({ app: "Slack", mode: "human", baseUrl: BASE })).id);
  assert.equal(first.status, "verified");
  assert.equal(first.strategy, "api");
  assert.equal(first.public.appId, "A0MOCK");
  assert.ok(await getSecret(vaultName("slack", first.id, "shared:config_refresh_token")));
  const second = await drive((await createRun({ app: "Slack", mode: "human", baseUrl: BASE })).id);
  const skipped = second.steps.filter((s) => s.state === "skipped").map((s) => s.id);
  assert.deepEqual(skipped, ["open-apps", "gen-config-token", "config-token", "config-refresh"]);
  assert.equal(second.goLive?.needed, true);
});

test("if the agent can't read a value, a person can paste it straight into the vault", async () => {
  process.env.PROVISION_MOCK_RECOVERY = "giveup";
  const run = await createRun({ app: "HubSpot", mode: "auto", baseUrl: BASE });
  // Break the client secret capture by making the step unreadable.
  const deps = defaultDeps();
  const open = deps.openBrowser;
  deps.openBrowser = async (o) => { const d = await open(o); return { ...d, capture: async (find: string, rev?: string) => { if (/secret/i.test(find)) throw new Error("value still masked"); return d.capture(find, rev); } }; };
  let r: Run = run;
  for (let i = 0; i < 20 && r.pending?.step !== "client-secret"; i++) r = await advance(run.id, deps, 30_000);
  assert.equal(r.pending?.step, "client-secret");
  assert.equal(r.pending?.field?.secret, true);
  await respond(run.id, "continue", "pasted-secret-value-123");
  const done = await drive(run.id);
  assert.equal(await getSecret(done.vault.client_secret), "pasted-secret-value-123");
  assert.ok(!JSON.stringify(done).includes("pasted-secret-value-123"));
});

test("cancel stops a run", async () => {
  const run = await createRun({ app: "Linear", mode: "human", baseUrl: BASE });
  await advance(run.id, defaultDeps(), 30_000);
  const r = await respond(run.id, "cancel");
  assert.equal(r.status, "cancelled");
  assert.equal((await advance(run.id, defaultDeps(), 30_000)).status, "cancelled");
});

test("the OAuth callback stores the code on the matching run only", async () => {
  const run = await createRun({ app: "Linear", mode: "auto", baseUrl: BASE });
  const r = await getRun(run.id);
  r!.verify = { state: "abc", verifier: "" };
  const { saveRun } = await import("../lib/provision/runs");
  await saveRun(r!);
  assert.equal(await attachCode("nope", "x"), null);
  assert.equal((await attachCode("abc", "the-code"))?.verify?.code, "the-code");
});

test("apps without a playbook are planned from their guide; apps without a guide are refused", async () => {
  const notion = libraryGuides().find((g) => g.slug === "notion")!;
  assert.deepEqual(validatePlaybook(mockPlanFromGuide(notion)), []);
  const run = await createRun({ app: "Notion", mode: "human", baseUrl: BASE });
  assert.equal(run.playbook.evidence, "unverified");
  await assert.rejects(createRun({ app: "Totally Unknown App", mode: "human", baseUrl: BASE }), NoGuideError);
});

test("a guide researched on the provision page is used even when its slug differs from the typed name", async () => {
  const notion = libraryGuides().find((g) => g.slug === "notion")!;
  await saveGuide({ ...notion, slug: "zoho-invoice", name: "Zoho Invoice", evidenceLevel: "generated" });
  await assert.rejects(createRun({ app: "Zoho", mode: "human", baseUrl: BASE }), NoGuideError);
  const run = await createRun({ app: "Zoho", mode: "human", baseUrl: BASE, guideSlug: "zoho-invoice" });
  assert.equal(run.playbook.evidence, "unverified");
});

test("tracker row has masked values and vault names, never secrets", async () => {
  const done = await drive((await createRun({ app: "Linear", mode: "auto", baseUrl: BASE })).id);
  const row = rowFor(done, BASE).join(" ");
  const secret = (await getSecret(done.vault.client_secret))!;
  assert.ok(!row.includes(secret));
  assert.ok(!row.includes(done.public.clientId!), "client ID is shortened in the sheet");
  assert.match(row, /linear\/linear-\d{8}-[0-9a-f]{6}\/client_secret/);
});

test("redaction and masking", async () => {
  assert.equal(redact("token abcdefgh123 leaked", ["abcdefgh123"]), "token [redacted] leaked");
  assert.equal(mask("abcdefghijkl"), "abcd••••kl");
  await putSecret("x/y/z", "v1");
  assert.equal(await getSecret("x/y/z"), "v1");
});

test("routes: open by default; access code and admin token apply only when set", async () => {
  delete process.env.PROVISION_MOCK;
  delete process.env.AGENT_MOCK;
  delete process.env.PROVISION_ACCESS_CODE;
  delete process.env.PROVISION_ADMIN_TOKEN;
  const post = (url: string, body: unknown, headers: Record<string, string> = {}) => new Request(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  // No code set: the gate lets the request through (it then fails later for its own reasons, not 401/503).
  assert.equal(gate(post(`${BASE}/api/provision`, { app: "Linear" })), null);
  process.env.PROVISION_ACCESS_CODE = "letmein";
  assert.equal((await createRoute(post(`${BASE}/api/provision`, { app: "Linear" }))).status, 401);
  assert.equal(gate(post(`${BASE}/api/provision`, { app: "Linear" }, { "x-access-code": "letmein" })), null);
  delete process.env.PROVISION_ACCESS_CODE;
  // No token set: a reveal is not refused for lack of a token (unknown run -> 404).
  let res = await revealRoute(post(`${BASE}/api/provision/x/reveal`, { label: "client_secret" }), { params: Promise.resolve({ id: "x" }) });
  assert.equal(res.status, 404);
  process.env.PROVISION_ADMIN_TOKEN = "admin";
  res = await revealRoute(post(`${BASE}/api/provision/x/reveal`, { label: "client_secret" }), { params: Promise.resolve({ id: "x" }) });
  assert.equal(res.status, 401);
  delete process.env.PROVISION_ADMIN_TOKEN;
  process.env.PROVISION_MOCK = "1";
  const ok = await createRoute(post(`${BASE}/api/provision`, { app: "Linear", mode: "auto" }));
  assert.equal(ok.status, 200);
  const run = (await ok.json()) as Run;
  await drive(run.id);
  const rv = await revealRoute(post(`${BASE}/api/provision/${run.id}/reveal`, { label: "client_secret" }), { params: Promise.resolve({ id: run.id }) });
  assert.match(((await rv.json()) as { value: string }).value, /^mock_secret_/);
  assert.ok((await getRun(run.id))!.events.some((e) => /client_secret revealed/.test(e.text)));
  void reveal;
});

test("a browser session that expired while the run waited is replaced, and the run carries on", async () => {
  const run = await createRun({ app: "Linear", mode: "human", baseUrl: BASE });
  const base = defaultDeps();
  let r = await advance(run.id, base, 30_000);
  const first = r.browser?.sessionId;
  assert.ok(first);
  // Reconnecting to the old session fails, as it does after Browserbase's timeout.
  const expired = { ...base, openBrowser: (o: { sessionId?: string; contextId?: string; mockFail?: string }) => (o.sessionId === first ? Promise.reject(new Error("session not running")) : base.openBrowser(o)) };
  if (r.status === "waiting_human" || r.status === "waiting_approval") r = await respond(run.id, r.status === "waiting_approval" ? "approve" : "continue");
  r = await advance(run.id, expired, 30_000);
  assert.notEqual(r.browser?.sessionId, first);
  assert.ok(r.events.some((e) => /previous browser session had ended/.test(e.text)));
  assert.notEqual(r.status, "failed");
});
