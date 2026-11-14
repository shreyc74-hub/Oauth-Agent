// The recovery agent: a failed browser or capture step goes to an agent loop before a person.
// Checks it recovers, records a playbook fix, respects approvals, walls, its budget and allowed
// sites, and that no secret ever reaches the model's transcript.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRun, advance, respond, defaultDeps, allowedHosts, type Deps } from "../lib/provision/engine";
import { _resetRuns } from "../lib/provision/runs";
import { getSecret, vaultName, _resetVault } from "../lib/provision/vault";
import { recover, hostAllowed, mockBrain, type Brain, type Block } from "../lib/provision/recover";
import { mockBrowser } from "../lib/provision/mock";
import type { Driver } from "../lib/provision/browser";
import type { Run } from "../lib/provision/types";

const BASE = "https://example.test";

beforeEach(() => {
  process.env.PROVISION_MOCK = "1";
  for (const k of ["PROVISION_MOCK_BLOCKER", "PROVISION_MOCK_RECOVERY", "PROVISION_RECOVERY", "SUPABASE_URL", "GOOGLE_SHEET_ID"]) delete process.env[k];
  _resetRuns(); _resetVault();
});

/** Mock deps whose browser fails one scripted step, and whose brain transcript is recorded. */
function rigged(opts: { failAct?: RegExp; failCapture?: RegExp; wallAfter?: RegExp; look?: (d: Driver) => Promise<{ url: string; title: string; elements: string[] }> } = {}) {
  const deps: Deps = defaultDeps();
  const transcripts: string[] = [];
  const brain: Brain = async (system, messages, tools) => { transcripts.push(JSON.stringify(messages)); return mockBrain(system, messages, tools); };
  deps.brain = brain;
  deps.openBrowser = async (o) => {
    const d = await mockBrowser(o);
    let wall = false;
    return {
      ...d,
      act: async (instruction, vars) => {
        if (opts.wallAfter?.test(instruction)) wall = true;
        if (opts.failAct?.test(instruction) && !/left sidebar/.test(instruction)) return { ok: false, message: "No element matches 'Create new application'" };
        return d.act(instruction, vars);
      },
      capture: async (find, reveal) => {
        if (opts.failCapture?.test(find)) throw new Error("value still masked");
        return d.capture(find, reveal);
      },
      blocker: async () => (wall ? { kind: "captcha" as const, detail: "Turnstile check" } : d.blocker()),
      look: opts.look ? () => opts.look!(d) : d.look,
    };
  };
  return { deps, transcripts };
}

async function drive(id: string, deps: Deps) {
  for (let i = 0; i < 60; i++) {
    const r = await advance(id, deps, 30_000);
    if (["verified", "needs_review", "failed", "cancelled"].includes(r.status)) return r;
    if (r.pending) await respond(id, r.pending.kind === "approval" ? "approve" : "continue");
  }
  throw new Error("run did not finish");
}

test("a failed browser step is recovered by the agent and a playbook fix is suggested", async () => {
  const { deps } = rigged({ failAct: /^Fill the application form/ });
  const run = await createRun({ app: "Linear", mode: "auto", baseUrl: BASE });
  const done = await drive(run.id, deps);
  assert.equal(done.status, "verified");
  const step = done.steps.find((s) => s.id === "fill-form")!;
  assert.equal(step.recovered, true);
  assert.equal(done.fixes?.length, 1);
  assert.equal(done.fixes![0].step, "fill-form");
  assert.ok(done.events.some((e) => e.kind === "agent" && /^look/.test(e.text)));
  assert.ok(done.events.some((e) => e.kind === "agent" && /^act: Open the menu/.test(e.text)));
  assert.equal(done.events.filter((e) => e.kind === "handoff").length, 0, "no person needed");
});

test("a failed capture is recovered into the vault, and no secret reaches the model", async () => {
  let runId = "";
  const { deps, transcripts } = rigged({
    failCapture: /^the Client secret value$/,
    // The page "shows" the agent's password; look output must be redacted before the model sees it.
    look: async (d) => ({ ...(await d.look()), elements: ["Password field", `Text: ${await getSecret(vaultName("linear", runId, "password"))}`] }),
  });
  const run = await createRun({ app: "Linear", mode: "auto", baseUrl: BASE });
  runId = run.id;
  const done = await drive(run.id, deps);
  assert.equal(done.status, "verified");
  assert.equal(done.steps.find((s) => s.id === "client-secret")!.recovered, true);
  const secret = await getSecret(done.vault.client_secret);
  const password = await getSecret(done.vault.password);
  assert.ok(secret && password);
  const all = transcripts.join("\n") + JSON.stringify(done.events);
  assert.ok(!all.includes(secret!), "client secret never in the transcript or log");
  assert.ok(!all.includes(password!), "password never in the transcript or log");
  assert.match(all, /\[redacted\]/);
});

test("human in the loop: the agent's own write action stops for approval, then runs", async () => {
  process.env.PROVISION_MOCK_RECOVERY = "write";
  const { deps } = rigged({ failAct: /^Fill the application form/ });
  const run = await createRun({ app: "Linear", mode: "human", baseUrl: BASE });
  let r: Run = run;
  for (let i = 0; i < 10 && !r.pending?.recovery; i++) {
    r = await advance(run.id, deps, 30_000);
    if (r.pending && !r.pending.recovery) r = await respond(run.id, r.pending.kind === "approval" ? "approve" : "continue");
  }
  assert.equal(r.status, "waiting_approval");
  assert.equal(r.pending?.recovery, "Click the button labelled Create app");
  assert.match(r.pending!.reason, /recovery agent wants to/);
  await respond(run.id, "approve");
  const done = await drive(run.id, deps);
  assert.equal(done.status, "verified");
  assert.ok(done.events.some((e) => e.text.startsWith("Approved for the recovery agent")));
  assert.equal(done.steps.find((s) => s.id === "fill-form")!.recovered, true);
});

test("a wall the agent runs into becomes a handoff, not a workaround", async () => {
  const { deps } = rigged({ failAct: /^Fill the application form/, wallAfter: /left sidebar/ });
  const run = await createRun({ app: "Linear", mode: "auto", baseUrl: BASE });
  let r: Run = run;
  for (let i = 0; i < 10 && r.status !== "waiting_human"; i++) r = await advance(run.id, deps, 30_000);
  assert.equal(r.pending?.blocker, "captcha");
  assert.equal(r.pending?.step, "fill-form");
});

test("the agent hands over with a note when it gives up or runs out of budget", async () => {
  process.env.PROVISION_MOCK_RECOVERY = "loop";
  const { deps } = rigged({ failAct: /^Fill the application form/ });
  const run = await createRun({ app: "Linear", mode: "auto", baseUrl: BASE });
  let r: Run = run;
  for (let i = 0; i < 10 && r.status !== "waiting_human"; i++) r = await advance(run.id, deps, 30_000);
  assert.equal(r.pending?.step, "fill-form");
  assert.match(r.pending!.reason, /used its budget \(8 actions/);
  assert.equal(r.events.filter((e) => e.kind === "agent" && e.text.startsWith("act:")).length, 7, "look + 7 acts = 8 actions");
});

test("recovery can be switched off", async () => {
  process.env.PROVISION_RECOVERY = "0";
  const { deps, transcripts } = rigged({ failAct: /^Fill the application form/ });
  const run = await createRun({ app: "Linear", mode: "auto", baseUrl: BASE });
  let r: Run = run;
  for (let i = 0; i < 10 && r.status !== "waiting_human"; i++) r = await advance(run.id, deps, 30_000);
  assert.equal(r.pending?.step, "fill-form");
  assert.equal(transcripts.length, 0);
});

test("the agent stays on the provider's sites", async () => {
  assert.ok(hostAllowed("https://app.linear.app/settings", ["linear.app"]));
  assert.ok(!hostAllowed("https://linear.app.evil.example/", ["linear.app"]));
  const run = await createRun({ app: "Linear", mode: "auto", baseUrl: BASE });
  assert.deepEqual(allowedHosts(run).sort(), ["example.test", "linear.app"]);

  const visited: string[] = [];
  const d = await mockBrowser({});
  const driver: Driver = { ...d, goto: async (u) => { visited.push(u); return d.goto(u); } };
  let turn = 0;
  const brain: Brain = async () => {
    turn++;
    const call = (name: string, input: Record<string, unknown>): Block[] => [{ type: "tool_use", id: `t${turn}`, name, input }];
    if (turn === 1) return call("act", { instruction: "Open the page", url: "https://evil.example/collect", is_write: false });
    return call("done", { summary: "ok" });
  };
  const res = await recover({
    driver, brain, mode: "auto", app: "Linear", error: "x",
    step: { id: "s", title: "Step", kind: "browser", instruction: "do it" },
    allowedHosts: ["linear.app"], captureLabels: [], variableNames: [], approved: [], hasInbox: false,
    resolveVars: async () => ({}), storeValue: async () => undefined, readInboxCode: async () => null,
    redact: (t) => t, trace: () => undefined, deadline: Date.now() + 10_000,
  });
  assert.equal(res.outcome, "recovered");
  assert.deepEqual(visited, [], "never navigated off the provider's sites");
});
