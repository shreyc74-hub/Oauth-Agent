// API routes: input handling, library-first lookup, permission rules for writes, rate limits, streams.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { req, readNdjson, installFake, message } from "./helpers";
import { POST as resolve } from "../app/api/resolve/route";
import { GET as listRoute, POST as saveRoute } from "../app/api/guides/route";
import { GET as oneRoute } from "../app/api/guides/[slug]/route";
import { POST as generate } from "../app/api/generate/route";
import { POST as chat } from "../app/api/chat/route";
import { GET as corrGet, POST as corrPost } from "../app/api/corrections/route";
import { limited } from "../lib/ratelimit";
import { libraryGuides } from "../lib/library";
import { getGuide, _resetMemoryStore } from "../lib/store";

const U = "http://localhost";
let ip = 0;
const nextIp = () => `10.9.${Math.floor(++ip / 250)}.${ip % 250}`;

beforeEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.AGENT_MOCK;
  delete process.env.SUPABASE_URL;
  process.env.AGENT_MOCK_FAST = "1";
  _resetMemoryStore();
});

const generated = () => {
  const base = structuredClone(libraryGuides().find((g) => g.slug === "linear")!) as any;
  return { ...base, slug: "acme", name: "Acme", website: "acme.io", evidenceLevel: "tested", evidence: [{ claim: "x", status: "tested", basis: "b" }, { claim: "y", status: "docs", basis: "d" }] };
};

// ---------- resolve ----------
test("resolve: empty and missing queries are rejected", async () => {
  assert.equal((await resolve(req(`${U}/api/resolve`, {}, nextIp()))).status, 400);
  assert.equal((await resolve(req(`${U}/api/resolve`, { query: "   " }, nextIp()))).status, 400);
  const bad = new Request(`${U}/api/resolve`, { method: "POST", body: "not json", headers: { "x-forwarded-for": nextIp() } });
  assert.equal((await resolve(bad)).status, 400);
});

test("resolve: library names, aliases and links open instantly without the model", async () => {
  process.env.ANTHROPIC_API_KEY = "k";
  const f = installFake([]);
  for (const [q, slug] of [["Slack", "slack"], ["sfdc", "salesforce"], ["https://www.notion.so/", "notion"], ["Google Mail", "gmail"]]) {
    const r = await (await resolve(req(`${U}/api/resolve`, { query: q }, nextIp()))).json();
    assert.deepEqual([r.kind, r.slug], ["library", slug], q);
  }
  f.restore();
  assert.equal(f.calls.length, 0, "no model call for library hits");
});

test("resolve: without an API key, unknown apps say the agent is off", async () => {
  const r = await (await resolve(req(`${U}/api/resolve`, { query: "Calendly" }, nextIp()))).json();
  assert.equal(r.kind, "notfound");
  assert.match(r.message, /isn't configured/);
});

test("resolve: rough names are confirmed, exact names go to research, confirmed vendors are re-checked", async () => {
  process.env.ANTHROPIC_API_KEY = "k";
  const f = installFake([
    message([{ text: '{"status":"ambiguous","candidates":[{"name":"monday.com","website":"monday.com"}],"reason":"Rough name"}' }]),
    message([{ text: '{"status":"unique","candidates":[{"name":"Calendly","website":"calendly.com"}]}' }]),
    message([{ text: '{"status":"unique","candidates":[{"name":"Slack","website":"slack.com"}]}' }]),
    message([{ text: '{"status":"unknown","reason":"No product called qwzx."}' }]),
  ]);
  const ask = async (body: unknown) => (await resolve(req(`${U}/api/resolve`, body, nextIp()))).json();
  assert.equal((await ask({ query: "monday" })).kind, "confirm");
  assert.deepEqual(await ask({ query: "Calendly scheduling" }), { kind: "new", vendor: { name: "Calendly", website: "calendly.com" }, slug: "calendly" });
  assert.equal((await ask({ query: "the slack app" })).kind, "library", "a model answer that is in the library opens the guide");
  assert.equal((await ask({ query: "qwzx" })).kind, "notfound");
  assert.deepEqual(await ask({ query: "x", confirmed: { name: "Linear", website: "linear.app" } }), { kind: "library", slug: "linear", name: "Linear" });
  assert.equal((await ask({ query: "x", confirmed: { name: "monday.com", website: "monday.com" } })).kind, "new");
  f.restore();
  assert.equal(f.calls.length, 4, "confirmed vendors need no model call");
});

test("resolve: model failures are reported, not thrown", async () => {
  process.env.ANTHROPIC_API_KEY = "k";
  const f = installFake([new Response("bad key", { status: 401 })]);
  const res = await resolve(req(`${U}/api/resolve`, { query: "Calendly" }, nextIp()));
  f.restore();
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /401/);
});

test("resolve: mock mode confirms short names and resolves longer ones", async () => {
  process.env.AGENT_MOCK = "1";
  assert.equal((await (await resolve(req(`${U}/api/resolve`, { query: "monday" }, nextIp()))).json()).kind, "confirm");
  const r = await (await resolve(req(`${U}/api/resolve`, { query: "https://calendly.com" }, nextIp()))).json();
  assert.deepEqual([r.kind, r.vendor.name, r.vendor.website], ["new", "Calendly", "calendly.com"]);
});

// ---------- guides: read and save (writes need the developer's click) ----------
test("guides: list and read, JSON and Markdown, 404 for unknown", async () => {
  const list = await (await listRoute()).json();
  assert.equal(list.length, 8);
  assert.ok(list.every((g: any) => g.trap && typeof g.oauthSupported === "boolean"));
  const one = await oneRoute(req(`${U}/api/guides/slack`), { params: { slug: "slack" } });
  assert.equal((await one.json()).slug, "slack");
  const md = await oneRoute(req(`${U}/api/guides/slack?format=md`), { params: { slug: "slack" } });
  assert.match(md.headers.get("content-type")!, /markdown/);
  assert.match(md.headers.get("content-disposition")!, /slack-oauth-readiness\.md/);
  assert.equal((await oneRoute(req(`${U}/api/guides/nope`), { params: { slug: "nope" } })).status, 404);
});

test("save: rejects empty, incomplete and library-overwriting guides", async () => {
  assert.equal((await saveRoute(req(`${U}/api/guides`, {}, nextIp()))).status, 400);
  const incomplete = await saveRoute(req(`${U}/api/guides`, { guide: { slug: "x", name: "X" } }, nextIp()));
  assert.equal(incomplete.status, 422);
  const lib = { ...generated(), slug: "slack" };
  const res = await saveRoute(req(`${U}/api/guides`, { guide: lib, overwrite: true }, nextIp()));
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /library guide/);
  assert.equal((await getGuide("slack"))!.evidenceLevel, "tested", "library guide untouched");
});

test("save: forces generated status, downgrades tested claims, and needs overwrite to replace", async () => {
  const ok = await saveRoute(req(`${U}/api/guides`, { guide: generated() }, nextIp()));
  assert.equal(ok.status, 200);
  const saved = (await getGuide("acme"))!;
  assert.equal(saved.evidenceLevel, "generated");
  assert.deepEqual(saved.evidence.map((e) => e.status), ["unverified", "docs"]);
  const dup = await saveRoute(req(`${U}/api/guides`, { guide: { ...generated(), verdict: "v2" } }, nextIp()));
  assert.equal(dup.status, 409);
  assert.equal((await getGuide("acme"))!.verdict, saved.verdict);
  const replace = await saveRoute(req(`${U}/api/guides`, { guide: { ...generated(), verdict: "v2" }, overwrite: true }, nextIp()));
  assert.equal(replace.status, 200);
  assert.equal((await getGuide("acme"))!.verdict, "v2");
  const list = await (await listRoute()).json();
  assert.equal(list.length, 9);
});

// ---------- generate ----------
test("generate: validates input and refuses without a key", async () => {
  assert.equal((await generate(req(`${U}/api/generate`, {}, nextIp()))).status, 400);
  assert.equal((await generate(req(`${U}/api/generate`, { name: "Acme" }, nextIp()))).status, 503);
});

test("generate: streams NDJSON events ending in done (mock)", async () => {
  process.env.AGENT_MOCK = "1";
  const ev = await readNdjson(await generate(req(`${U}/api/generate`, { name: "Calendly", website: "calendly.com" }, nextIp())));
  assert.equal(ev.filter((e) => e.type === "section").length, 14);
  assert.ok(ev.some((e) => e.type === "selfcheck"));
  assert.equal(ev[ev.length - 1].type, "done");
});

test("generate: an agent failure arrives as an error event", async () => {
  process.env.ANTHROPIC_API_KEY = "k";
  const f = installFake([message([{ text: "nothing useful" }])]);
  const ev = await readNdjson(await generate(req(`${U}/api/generate`, { name: "Nope", website: "" }, nextIp())));
  f.restore();
  assert.equal(ev[ev.length - 1].type, "error");
  assert.match(ev[ev.length - 1].message, /stopped without writing/);
});

test("generate: rate limited per network", async () => {
  process.env.AGENT_MOCK = "1";
  process.env.GENERATE_LIMIT_PER_HOUR = "2";
  const me = nextIp();
  for (let i = 0; i < 2; i++) await (await generate(req(`${U}/api/generate`, { name: "A" }, me))).text();
  assert.equal((await generate(req(`${U}/api/generate`, { name: "A" }, me))).status, 429);
  assert.equal((await generate(req(`${U}/api/generate`, { name: "A" }, nextIp()))).status, 200, "other networks unaffected");
  delete process.env.GENERATE_LIMIT_PER_HOUR;
});

// ---------- chat ----------
test("chat: validates messages, refuses without a key, streams in mock mode", async () => {
  assert.equal((await chat(req(`${U}/api/chat`, { messages: [] }, nextIp()))).status, 400);
  assert.equal((await chat(req(`${U}/api/chat`, { messages: [{ role: "user", content: "hi" }] }, nextIp()))).status, 503);
  process.env.AGENT_MOCK = "1";
  const ev = await readNdjson(await chat(req(`${U}/api/chat`, { slug: "gmail", messages: [{ role: "user", content: "How long?" }] }, nextIp())));
  assert.ok(ev.some((e) => e.type === "text"));
  assert.equal(ev[ev.length - 1].type, "done");
});

test("chat: an unknown slug still answers from the library", async () => {
  process.env.AGENT_MOCK = "1";
  const ev = await readNdjson(await chat(req(`${U}/api/chat`, { slug: "../../etc", messages: [{ role: "user", content: "about calendly" }] }, nextIp())));
  assert.ok(ev.some((e) => e.type === "action" && e.action.kind === "research"));
});

// ---------- corrections: the only write the chat agent can propose ----------
test("corrections: validate, require an existing guide, save only on POST", async () => {
  assert.equal((await corrPost(req(`${U}/api/corrections`, { slug: "slack" }, nextIp()))).status, 400);
  assert.equal((await corrPost(req(`${U}/api/corrections`, { slug: "nope", claim: "a", correction: "b" }, nextIp()))).status, 404);
  assert.deepEqual(await (await corrGet(req(`${U}/api/corrections?slug=slack`))).json(), []);
  const ok = await corrPost(req(`${U}/api/corrections`, { slug: "slack", section: "limits", claim: "1/min", correction: "2/min", source: "x".repeat(900) }, nextIp()));
  assert.equal(ok.status, 200);
  const list = await (await corrGet(req(`${U}/api/corrections?slug=slack`))).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].source.length, 300, "inputs are length-capped");
  assert.deepEqual(await (await corrGet(req(`${U}/api/corrections`))).json(), []);
});

// ---------- rate limiter ----------
test("limited: allows max per window, separates buckets and IPs, resets after the window", async () => {
  const r = (ip: string) => new Request(U, { headers: { "x-forwarded-for": `${ip}, 70.0.0.1` } });
  assert.equal(limited(r("5.5.5.5"), "t", 2, 50), false);
  assert.equal(limited(r("5.5.5.5"), "t", 2, 50), false);
  assert.equal(limited(r("5.5.5.5"), "t", 2, 50), true);
  assert.equal(limited(r("5.5.5.5"), "other", 2, 50), false);
  assert.equal(limited(r("6.6.6.6"), "t", 2, 50), false);
  await new Promise((res) => setTimeout(res, 60));
  assert.equal(limited(r("5.5.5.5"), "t", 2, 50), false);
});
