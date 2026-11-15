// The start page's "What's happening" panel: POST /api/provision streams each step as NDJSON when
// asked, and keeps answering plain JSON otherwise.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { POST as createRoute } from "../app/api/provision/route";
import { _resetRuns } from "../lib/provision/runs";
import { _resetVault } from "../lib/provision/vault";

beforeEach(() => { process.env.PROVISION_MOCK = "1"; delete process.env.SUPABASE_URL; delete process.env.GOOGLE_SHEET_ID; delete process.env.PROVISION_ACCESS_CODE; _resetRuns(); _resetVault(); });

const post = (body: unknown, accept = "application/json") => new Request("https://example.test/api/provision", { method: "POST", headers: { "content-type": "application/json", accept, "x-forwarded-for": `10.0.0.${Math.floor(Math.random() * 200)}` }, body: JSON.stringify(body) });

async function lines(res: Response) {
  const text = await res.text();
  return text.trim().split("\n").map((l) => JSON.parse(l) as { type: string; id?: string; state?: string; label?: string; ms?: number; status?: number; body?: Record<string, unknown> });
}

test("streams each step with start and finish, then the run", async () => {
  const res = await createRoute(post({ app: "Linear", mode: "human", useCase: "read issues" }, "application/x-ndjson"));
  assert.match(res.headers.get("content-type") || "", /ndjson/);
  const ev = await lines(res);
  const ids = ev.filter((e) => e.type === "progress").map((e) => `${e.id}:${e.state}`);
  for (const want of ["setup:done", "guide:start", "guide:done", "sandbox:start", "sandbox:done", "plan:start", "plan:done", "scopes:start", "scopes:done", "save:start", "save:done"]) assert.ok(ids.includes(want), want);
  assert.ok(ids.indexOf("sandbox:done") < ids.indexOf("plan:start"), "sandbox check comes before planning");
  const last = ev[ev.length - 1];
  assert.equal(last.type, "result");
  assert.equal(last.status, 200);
  assert.ok((last.body as { id?: string }).id);
});

test("errors arrive as the final result line with the same body as the JSON answer", async () => {
  const ev = await lines(await createRoute(post({ app: "Totally Unknown App" }, "application/x-ndjson")));
  const last = ev[ev.length - 1];
  assert.equal(last.status, 404);
  assert.equal((last.body as { noGuide?: boolean }).noGuide, true);
  assert.ok(ev.some((e) => e.id === "guide" && e.state === "done"));
});

test("without the stream header the route still answers plain JSON", async () => {
  const res = await createRoute(post({ app: "Linear", mode: "human" }));
  assert.match(res.headers.get("content-type") || "", /json/);
  assert.ok(((await res.json()) as { id?: string }).id);
});

test("without a mode the route researches and plans only: the run is ready, with an assessment and a recommendation", async () => {
  const ev = await lines(await createRoute(post({ app: "Linear" }, "application/x-ndjson")));
  const ids = ev.filter((e) => e.type === "progress").map((e) => `${e.id}:${e.state}`);
  for (const want of ["sandbox:done", "credentials:done", "route:done", "plan:done", "assess:done"]) assert.ok(ids.includes(want), want);
  const body = ev[ev.length - 1].body as { status?: string; assessment?: { recommendedMode?: string } };
  assert.equal(body.status, "ready");
  assert.ok(body.assessment?.recommendedMode);
});
