// The agent loop (fake Claude API), the stream parser, page rendering, vendor lookup, self-check.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installFake, message, sse } from "./helpers";
import { runClaude, extractJson, webTools, MAX_ROUNDS } from "../lib/agent/claude";
import { createSectionParser, inferStage, type AgentEvent } from "../lib/agent/parse";
import { publicUrl, isThin, htmlToText, renderProvider, renderPage } from "../lib/agent/render";
import { parseIdentified, cleanDomain, looksLikeUrl, identify, readMeta } from "../lib/agent/resolve";
import { ruleChecks, applyReview, countStatuses } from "../lib/agent/selfcheck";
import { libraryGuides } from "../lib/library";

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.RENDER_PROVIDER;
  delete process.env.BROWSERLESS_TOKEN;
  delete process.env.JINA_API_KEY;
});

// ---------- runClaude ----------
test("runClaude streams text and returns the final message", async () => {
  const f = installFake([message([{ text: "Hello there" }])]);
  const deltas: string[] = [];
  const out = await runClaude({ system: "s", messages: [{ role: "user", content: "hi" }] }, { onText: (d) => deltas.push(d) });
  f.restore();
  assert.equal(out, "Hello there");
  assert.equal(deltas.join(""), "Hello there");
  assert.equal(f.calls[0].headers["x-api-key"], "test-key");
  assert.equal(f.calls[0].headers["anthropic-version"], "2023-06-01");
  assert.equal(f.calls[0].body.stream, true);
  assert.equal(f.calls[0].body.tools, undefined, "no tools sent when none given");
});

test("runClaude continues a pause_turn and sends the partial turn back without empty text blocks", async () => {
  const f = installFake([
    message([{ text: "" }, { tool: "web_search", input: { query: "slack oauth" }, server: true }, { raw: { type: "web_search_tool_result", tool_use_id: "tu_1", content: [] } }], "pause_turn"),
    message([{ text: "Done." }]),
  ]);
  const tools: string[] = [];
  const out = await runClaude({ system: "s", messages: [{ role: "user", content: "go" }], tools: webTools(2, 1) }, { onToolUse: (n, i) => tools.push(`${n}:${i.query}`) });
  f.restore();
  assert.equal(out, "Done.");
  assert.deepEqual(tools, ["web_search:slack oauth"]);
  const second = f.calls[1].body.messages;
  assert.equal(second.length, 2);
  assert.equal(second[1].role, "assistant");
  assert.ok(!second[1].content.some((b: any) => b.type === "text" && !b.text), "empty text block was sent back");
  assert.deepEqual(second[1].content.map((b: any) => b.type), ["server_tool_use", "web_search_tool_result"]);
  assert.deepEqual(second[1].content[0].input, { query: "slack oauth" });
});

test("runClaude sends thinking blocks back complete (thinking text and signature) when a turn continues", async () => {
  const thinking = [
    { type: "message_start", message: { id: "m", role: "assistant", content: [] } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "I should search " } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "the docs." } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig123" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "Searching." } },
    { type: "content_block_delta", index: 2, delta: { type: "citations_delta", citation: { type: "web_search_result_location", url: "https://x" } } },
    { type: "content_block_stop", index: 2 },
    { type: "content_block_start", index: 3, content_block: { type: "redacted_thinking", data: "abc" } },
    { type: "content_block_stop", index: 3 },
    { type: "message_delta", delta: { stop_reason: "pause_turn" } },
    { type: "message_stop" },
  ];
  const f = installFake([thinking, message([{ text: "Done." }])]);
  const out = await runClaude({ system: "s", messages: [{ role: "user", content: "go" }] });
  f.restore();
  assert.equal(out, "Done.");
  const sent = f.calls[1].body.messages[1].content;
  assert.deepEqual(sent[0], { type: "thinking", thinking: "I should search the docs.", signature: "sig123" });
  assert.equal(sent.filter((b: any) => b.type === "thinking").length, 1, "empty thinking block dropped");
  assert.deepEqual(sent[1], { type: "text", text: "Searching." });
  assert.deepEqual(sent[2], { type: "redacted_thinking", data: "abc" });
});

test("webTools uses the current tool versions and drops fetch when the budget is 0", () => {
  assert.deepEqual(webTools(3, 2).map((t: any) => t.type), ["web_search_20260318", "web_fetch_20260318"]);
  assert.deepEqual(webTools(3, 0).map((t: any) => t.type), ["web_search_20260318"]);
});

test("runClaude runs client tools and returns their results, including errors and unknown tools", async () => {
  const f = installFake([
    message([{ text: "Let me check." }, { tool: "echo", input: { v: 1 }, id: "a" }, { tool: "boom", input: {}, id: "b" }, { tool: "ghost", input: {}, id: "c" }], "tool_use"),
    message([{ text: "Answer." }]),
  ]);
  const out = await runClaude({
    system: "s", messages: [{ role: "user", content: "q" }],
    clientTools: [
      { name: "echo", description: "", input_schema: { type: "object" }, run: async (i) => `echo ${JSON.stringify(i)}` },
      { name: "boom", description: "", input_schema: { type: "object" }, run: async () => { throw new Error("kaput"); } },
    ],
  });
  f.restore();
  assert.equal(out, "Answer.");
  assert.deepEqual(f.calls[0].body.tools.map((t: any) => t.name), ["echo", "boom"]);
  assert.ok(!("run" in f.calls[0].body.tools[0]), "run() must not be sent to the API");
  const results = f.calls[1].body.messages[2].content;
  assert.deepEqual(results.map((r: any) => r.tool_use_id), ["a", "b", "c"]);
  assert.equal(results[0].content, 'echo {"v":1}');
  assert.equal(results[1].content, "Error: kaput");
  assert.match(results[2].content, /Unknown tool ghost/);
});

test("runClaude truncates huge tool results", async () => {
  const f = installFake([message([{ tool: "big", input: {} }], "tool_use"), message([{ text: "ok" }])]);
  await runClaude({ system: "s", messages: [{ role: "user", content: "q" }], clientTools: [{ name: "big", description: "", input_schema: {}, run: async () => "x".repeat(100_000) }] });
  f.restore();
  assert.equal(f.calls[1].body.messages[2].content[0].content.length, 60_000);
});

test("runClaude reports API errors, stream errors and a missing key", async () => {
  let f = installFake([new Response('{"error":{"message":"rate limited"}}', { status: 429 })]);
  await assert.rejects(runClaude({ system: "s", messages: [{ role: "user", content: "q" }] }), /Claude API error 429.*rate limited/);
  f.restore();
  f = installFake([sse([{ type: "message_start", message: {} }, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }])]);
  await assert.rejects(runClaude({ system: "s", messages: [{ role: "user", content: "q" }] }), /Overloaded/);
  f.restore();
  delete process.env.ANTHROPIC_API_KEY;
  await assert.rejects(runClaude({ system: "s", messages: [{ role: "user", content: "q" }] }), /ANTHROPIC_API_KEY/);
});

test("runClaude stops after MAX_ROUNDS of pauses instead of looping forever", async () => {
  const f = installFake(Array.from({ length: MAX_ROUNDS + 2 }, () => message([{ text: "still going" }], "pause_turn")));
  const out = await runClaude({ system: "s", messages: [{ role: "user", content: "q" }] });
  f.restore();
  assert.equal(f.calls.length, MAX_ROUNDS);
  assert.equal(out, "still going");
});

test("runClaude honours ANTHROPIC_BASE_URL", async () => {
  process.env.ANTHROPIC_BASE_URL = "https://proxy.example.com";
  const f = installFake([message([{ text: "ok" }])]);
  await runClaude({ system: "s", messages: [{ role: "user", content: "q" }] });
  f.restore();
  assert.equal(f.calls[0].url, "https://proxy.example.com/v1/messages");
});

test("extractJson handles fences, prose and bad input", () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Sure! {"a":{"b":2}} hope that helps'), { a: { b: 2 } });
  assert.throws(() => extractJson("no json here"), /did not return JSON/);
  assert.throws(() => extractJson("{broken"), /did not return JSON|JSON/);
});

// ---------- Stream parser ----------
function parse(chunks: string[]) {
  const ev: AgentEvent[] = [];
  const p = createSectionParser({ slug: "acme", today: "2026-10-28", emit: (e) => ev.push(e) });
  chunks.forEach((c) => p.push(c));
  p.end();
  return { ev, seen: p.seen };
}

test("parser handles lines split across chunks, fences, narration and duplicates", () => {
  const header = JSON.stringify({ section: "header", data: { name: "Acme", slug: "WRONG", evidenceLevel: "tested", oauth: { supported: true }, verdict: "v" } });
  const glance = JSON.stringify({ section: "glance", data: { x: 1 } });
  const { ev, seen } = parse([
    'I will research now.\n{"stage":"oa', 'uth"}\n{"stage":"docs"}\n',
    "```json\n", header.slice(0, 20), header.slice(20) + "\n",
    glance + "\n", glance + "\n", // duplicate ignored
    '{"section":"nonsense","data":{}}\n', // unknown ignored
    '{"section":"tokens","data":null}\n', // null ignored
    "{not json}\n```\n",
    JSON.stringify({ section: "limits", data: { ladder: [] } }), // last line without newline
  ]);
  const sections = ev.filter((e) => e.type === "section") as Extract<AgentEvent, { type: "section" }>[];
  assert.deepEqual(sections.map((s) => s.section), ["header", "glance", "limits"]);
  assert.deepEqual([...seen], ["header", "glance", "limits"]);
  const h = sections[0].data as any;
  assert.equal(h.slug, "acme", "slug is forced by the server");
  assert.equal(h.evidenceLevel, "generated", "generated guides can never claim tested");
  assert.equal(h.checkedOn, "2026-10-28");
  const stages = ev.filter((e) => e.type === "stage").map((e: any) => `${e.stage}:${e.state}`);
  assert.deepEqual(stages, ["oauth:active", "oauth:done", "docs:active", "docs:done", "write:active", "write:done"]);
});

test("parser: stages only move forward, and the OAuth result is reported once", () => {
  const { ev } = parse(['{"stage":"docs"}\n', '{"stage":"oauth"}\n', '{"oauth":{"supported":true,"note":"OAuth 2.0 for public apps"}}\n', '{"oauth":{"supported":false,"note":"dup"}}\n', '{"stage":"composio"}\n', '{"stage":"changelog"}\n']);
  assert.deepEqual(ev.filter((e) => e.type === "stage" && e.state === "active").map((e: any) => e.stage), ["docs", "composio"]);
  assert.deepEqual(ev.filter((e) => e.type === "oauth"), [{ type: "oauth", supported: true, note: "OAuth 2.0 for public apps" }]);
});

test("parser: the header reports OAuth support when no marker came first", () => {
  const { ev } = parse([JSON.stringify({ section: "header", data: { name: "K", oauth: { supported: false, note: "API keys only" }, verdict: "v" } }) + "\n"]);
  assert.deepEqual(ev.find((e) => e.type === "oauth"), { type: "oauth", supported: false, note: "API keys only" });
});

test("inferStage maps tool activity to research stages", () => {
  const i = (k: any, t: string) => inferStage(k, t, "calendly.com");
  assert.equal(i("fetch", "https://developer.calendly.com/docs/oauth"), "docs");
  assert.equal(i("fetch", "https://calendly.com/help/apps"), "docs");
  assert.equal(i("search", "Calendly OAuth app scopes rate limits"), "docs");
  assert.equal(i("search", "Calendly API changelog 2026"), "changelog");
  assert.equal(i("fetch", "https://developer.calendly.com/release-notes"), "changelog");
  assert.equal(i("fetch", "https://community.calendly.com/t/oauth-error/123"), "secondary");
  assert.equal(i("fetch", "https://nango.dev/docs/integrations/calendly"), "secondary");
  assert.equal(i("search", "Calendly app review how long did it take"), "secondary");
  assert.equal(i("fetch", "https://docs.composio.dev/toolkits/calendly"), "composio");
  assert.equal(i("search", "composio calendly managed auth"), "composio");
  assert.equal(i("skill", "scope-risk"), "docs");
  assert.equal(i("skill", "js-pages"), null);
  assert.equal(i("search", "hello"), null);
});

test("parser ignores unknown stages and non-object headers", () => {
  const { ev } = parse(['{"stage":"hack"}\n', '{"section":"header","data":"string"}\n']);
  assert.equal(ev.length, 0);
});

// ---------- Rendering ----------
test("publicUrl rejects internal and malformed targets", () => {
  for (const bad of ["http://localhost:3000", "http://127.0.0.1/x", "http://10.0.0.5", "http://192.168.1.1", "http://172.20.1.1", "http://169.254.169.254/latest", "ftp://example.com", "http://user:pass@example.com", "http://intranet", "https://db.internal/x", "http://[::1]/", "not a url at all"]) {
    assert.equal(publicUrl(bad), null, bad);
  }
  assert.equal(publicUrl("calendly.com")?.toString(), "https://calendly.com/");
  assert.equal(publicUrl("https://developer.zoom.us/docs")?.hostname, "developer.zoom.us");
  assert.notEqual(publicUrl("http://172.15.0.1"), null, "172.15 is public");
});

test("isThin spots JavaScript app shells", () => {
  assert.equal(isThin('<html><head><script>var a=1</script></head><body><div id="root"></div><noscript>Enable JavaScript</noscript></body></html>'), true);
  assert.equal(isThin(`<html><body><p>${"Real docs text. ".repeat(40)}</p></body></html>`), false);
  assert.equal(htmlToText("<p>a&nbsp;&amp;&nbsp;b</p>"), "a & b");
});

test("renderProvider defaults to jina, needs a token for browserless, can be off", () => {
  assert.equal(renderProvider(), "jina");
  process.env.RENDER_PROVIDER = "browserless";
  assert.equal(renderProvider(), "off", "browserless without a token is off");
  process.env.BROWSERLESS_TOKEN = "t";
  assert.equal(renderProvider(), "browserless");
  process.env.RENDER_PROVIDER = "OFF";
  assert.equal(renderProvider(), "off");
});

test("renderPage calls the reader with the key, truncates, and refuses private URLs", async () => {
  process.env.JINA_API_KEY = "jk";
  let seen: { url: string; auth?: string } | null = null;
  const f = installFake([], (url, init) => { seen = { url, auth: (init?.headers as any)?.authorization }; return new Response("Title\n" + "word ".repeat(20000)); });
  const r = await renderPage("https://app.example.com/docs", { maxChars: 100 });
  f.restore();
  assert.equal(seen!.url, "https://r.jina.ai/https://app.example.com/docs");
  assert.equal(seen!.auth, "Bearer jk");
  assert.equal(r.text.length, 100);
  await assert.rejects(renderPage("http://localhost/x"), /public/);
  process.env.RENDER_PROVIDER = "off";
  await assert.rejects(renderPage("https://example.com"), /turned off/);
});

test("renderPage reports renderer failures and empty pages", async () => {
  let f = installFake([], () => new Response("nope", { status: 502 }));
  await assert.rejects(renderPage("https://example.com"), /502/);
  f.restore();
  f = installFake([], () => new Response("   "));
  await assert.rejects(renderPage("https://example.com"), /no readable text/);
  f.restore();
});

test("renderPage with browserless posts the URL and strips HTML", async () => {
  process.env.RENDER_PROVIDER = "browserless"; process.env.BROWSERLESS_TOKEN = "bt";
  let body: any = null; let url = "";
  const f = installFake([], (u, init) => { url = u; body = JSON.parse(String(init?.body)); return new Response("<html><body><h1>Zoom Marketplace</h1><script>x</script></body></html>"); });
  const r = await renderPage("marketplace.zoom.us");
  f.restore();
  assert.match(url, /\/content\?token=bt$/);
  assert.equal(body.url, "https://marketplace.zoom.us/");
  assert.equal(r.text, "Zoom Marketplace");
});

// ---------- Vendor lookup ----------
test("cleanDomain and looksLikeUrl", () => {
  assert.equal(cleanDomain("https://www.Monday.com/pricing?x=1"), "monday.com");
  assert.equal(cleanDomain("calendly.com:443"), "calendly.com");
  assert.equal(cleanDomain(""), "");
  assert.ok(looksLikeUrl("https://calendly.com"));
  assert.ok(looksLikeUrl("developer.zoom.us/docs/api"));
  assert.ok(!looksLikeUrl("monday"));
  assert.ok(!looksLikeUrl("Microsoft Teams"));
});

test("readMeta reads title, og:site_name in either attribute order, and description", () => {
  const m = readMeta('<title>Calendly</title><meta content="Calendly Inc" property="og:site_name"><meta name="description" content="Scheduling">');
  assert.deepEqual(m, { title: "Calendly", siteName: "Calendly Inc", description: "Scheduling" });
});

test("parseIdentified: unique, ambiguous, unknown, junk and duplicates", () => {
  assert.deepEqual(parseIdentified('{"status":"unique","candidates":[{"name":"Zoom","website":"https://www.zoom.us/"}]}', "zoom"), { status: "unique", vendor: { name: "Zoom", website: "zoom.us", description: undefined } });
  const amb = parseIdentified('{"status":"ambiguous","candidates":[{"name":"monday.com","website":"monday.com"},{"name":"monday.com","website":"www.monday.com"},{"name":"monday CRM","website":"monday.com/crm"},{"name":""},{"name":"A","website":"a.com"},{"name":"B","website":"b.com"},{"name":"C","website":"c.com"}],"reason":"r"}', "monday");
  assert.equal(amb.status, "ambiguous");
  if (amb.status === "ambiguous") { assert.equal(amb.candidates.length, 4); assert.equal(amb.candidates[0].name, "monday.com"); }
  assert.equal(parseIdentified('{"status":"unknown","reason":"Nothing found"}', "zzz").status, "unknown");
  assert.equal(parseIdentified("I think it's Zoom", "zoom").status, "unknown");
  assert.equal(parseIdentified('{"status":"unique","candidates":[]}', "x").status, "unknown");
});

test("identify renders a JavaScript-only link before asking the model, and never gives up on it", async () => {
  const f = installFake(
    [(body) => {
      const ctx = body.messages[0].content as string;
      assert.match(ctx, /It is a link/);
      assert.match(ctx, /rendered in a browser/);
      assert.match(ctx, /Acme Scheduling/);
      assert.equal(body.tools.length, 1, "lookup uses search only");
      return message([{ text: '{"status":"unique","candidates":[{"name":"Acme","website":"acme.io"}]}' }]);
    }],
    (url) => url.startsWith("https://r.jina.ai/") ? new Response("Acme Scheduling: book meetings") : new Response('<html><head><title>App</title></head><body><div id="root"></div></body></html>'),
  );
  const r = await identify("https://app.acme.io/signup");
  f.restore();
  assert.deepEqual(r, { status: "unique", vendor: { name: "Acme", website: "acme.io", description: undefined } });
  assert.deepEqual(f.otherCalls, ["https://app.acme.io/signup", "https://r.jina.ai/https://app.acme.io/signup"]);
});

test("identify still works when the link can't be fetched or rendered", async () => {
  const f = installFake([message([{ text: '{"status":"unique","candidates":[{"name":"Acme","website":"acme.io"}]}' }])], () => { throw new Error("offline"); });
  const r = await identify("acme.io");
  f.restore();
  assert.equal(r.status, "unique");
});

test("identify does not fetch anything for plain names", async () => {
  const f = installFake([message([{ text: '{"status":"ambiguous","candidates":[{"name":"monday.com","website":"monday.com"}],"reason":"Rough name"}' }])]);
  const r = await identify("monday");
  f.restore();
  assert.equal(r.status, "ambiguous");
  assert.deepEqual(f.otherCalls, []);
});

// ---------- Self-check ----------
test("ruleChecks downgrades unsupported claims and cleans sources and owners", () => {
  const g = {
    oauth: { supported: true },
    sources: [{ title: "Docs", url: "https://x.com/docs" }, { title: "Bad", url: "javascript:alert(1)" }, { title: "", url: "https://y.com" }],
    evidence: [{ claim: "A", status: "tested", basis: "we did" }, { claim: "B", status: "docs", basis: "" }, { claim: "C", status: "docs", basis: "Docs page" }, { claim: "D", status: "weird", basis: "x" }, { claim: "", status: "docs", basis: "x" }],
    steps: [{ owner: "agent", title: "a", detail: "", time: "" }, { owner: "robot", title: "b", detail: "", time: "" }],
    limits: { ladder: [{}], notes: [] },
    glance: { approval: { rating: 4 } }, approval: { stages: [] },
  } as any;
  const { guide, notes } = ruleChecks(g);
  assert.deepEqual(guide.sources!.map((s) => s.title), ["Docs"]);
  assert.deepEqual(guide.evidence!.map((e) => e.status), ["unverified", "unverified", "docs", "unverified"]);
  assert.equal(guide.steps![1].owner, "you");
  assert.ok(notes.some((n) => n.includes("ladder")));
  assert.ok(notes.some((n) => n.includes("no review stages")));
  assert.equal(g.evidence[0].status, "tested", "input is not mutated");
});

test("ruleChecks: with no sources at all, nothing can be 'official docs'", () => {
  const { guide } = ruleChecks({ oauth: { supported: true }, sources: [], evidence: [{ claim: "A", status: "docs", basis: "Docs page" }] } as any);
  assert.equal(guide.evidence![0].status, "unverified");
});

test("ruleChecks leaves the library guides' statuses intact", () => {
  for (const g of libraryGuides().filter((x) => x.evidenceLevel !== "tested")) {
    assert.deepEqual(ruleChecks(g).guide.evidence!.map((e) => e.status), g.evidence.map((e) => e.status), g.slug);
  }
});

test("applyReview only lowers statuses (or marks conflicts) and ignores mismatched reviews", () => {
  const g = { evidence: [{ claim: "A", status: "docs", basis: "a" }, { claim: "B", status: "unverified", basis: "b" }, { claim: "C", status: "secondary", basis: "c" }] } as any;
  const r = applyReview(g, { evidence: [{ claim: "A", status: "secondary", basis: "third party only" }, { claim: "B", status: "docs", basis: "raise!" }, { claim: "C", status: "conflict", basis: "two values" }] });
  assert.deepEqual(r.guide.evidence!.map((e) => e.status), ["secondary", "unverified", "conflict"]);
  assert.equal(r.changed, 2);
  assert.equal(applyReview(g, { evidence: [{ claim: "A", status: "unverified", basis: "" }] }).changed, 0, "length mismatch ignored");
  assert.equal(applyReview(g, {}).changed, 0);
  assert.deepEqual(countStatuses(r.guide), { docs: 0, secondary: 1, conflict: 1, unverified: 1 });
});
