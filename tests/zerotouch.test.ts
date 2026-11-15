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
