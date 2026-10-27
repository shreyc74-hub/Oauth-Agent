// The research agent and the chat agent, end to end against a fake Claude API.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installFake, message } from "./helpers";
import { researchGuide, researchSystem, type AgentEvent } from "../lib/agent/research";
import { runChat, chatTools, chatSystem, cleanMessages, type ChatEvent } from "../lib/agent/chat";
import { libraryGuides } from "../lib/library";
import { SECTION_ORDER } from "../lib/schema";
import { listCorrections, listGuides, _resetMemoryStore } from "../lib/store";

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.AGENT_MOCK;
  process.env.AGENT_MOCK_FAST = "1";
  process.env.RENDER_PROVIDER = "jina";
  delete process.env.SUPABASE_URL;
  _resetMemoryStore();
});

const linear = libraryGuides().find((g) => g.slug === "linear")!;
function guideLines(name: string): string {
  const g = linear as any;
  return SECTION_ORDER.map((k) => JSON.stringify({
    section: k,
    data: k === "header" ? { name, website: "acme.io", category: "Scheduling", oauth: { supported: true, note: "" }, verdict: "Fast to create." }
      : k === "evidence" ? { evidence: [{ claim: "Install cap 50", status: "docs", basis: "Acme docs" }, { claim: "Review 2 weeks", status: "secondary", basis: "Forum" }, { claim: "Tokens 1 hour", status: "docs", basis: "Acme docs" }], sources: [{ title: "Acme docs", url: "https://developer.acme.io/oauth" }] }
      : g[k],
  })).join("\n");
}

// ---------- Research ----------
test("research system prompt lists tools and skills, and preloads the research skill", () => {
  const s = researchSystem();
  assert.match(s, /load_skill/);
  assert.match(s, /render_page/);
  assert.match(s, /approval-programs/);
  assert.match(s, /scope-risk/);
  assert.match(s, /Research order|research order|in this order/i);
  assert.ok(!s.includes("answering-questions"), "chat-only skill not offered to research");
  process.env.RENDER_PROVIDER = "off";
  assert.ok(!researchSystem().includes("render_page"), "render tool hidden when rendering is off");
});

test("research: the model loads a skill, renders a JS page, searches, then streams every section; self-check runs", async () => {
  const f = installFake([
    (body) => {
      assert.deepEqual(body.tools.map((t: any) => t.name), ["web_search", "web_fetch", "load_skill", "render_page"]);
      return message([{ text: '{"stage":"oauth"}\n' }, { tool: "web_search", input: { query: "Acme OAuth" }, server: true }, { tool: "load_skill", input: { name: "approval-programs" }, id: "s1" }, { tool: "render_page", input: { url: "https://developer.acme.io/oauth" }, id: "r1" }], "tool_use");
    },
    (body) => {
      const results = body.messages[2].content;
      assert.match(results[0].content, /# Skill: approval-programs/);
      assert.match(results[1].content, /Rendered https:\/\/developer.acme.io\/oauth/);
      return message([{ text: '{"stage":"docs"}\n' + guideLines("Acme") }]);
    },
    // self-check review: lowers one claim and adds a note
    message([{ text: JSON.stringify({ evidence: [{ claim: "Install cap 50", status: "secondary", basis: "only a forum says it" }, { claim: "Review 2 weeks", status: "secondary", basis: "Forum" }, { claim: "Tokens 1 hour", status: "docs", basis: "Acme docs" }], notes: ["The install cap appears only on a forum."] }) }]),
  ], () => new Response("Acme developer docs. OAuth apps are created in the console."));

  const ev: AgentEvent[] = [];
  await researchGuide({ name: "Acme", website: "acme.io" }, (e) => ev.push(e));
  f.restore();

  const sections = ev.filter((e) => e.type === "section").map((e: any) => e.section);
  assert.deepEqual(sections.slice(0, 14), [...SECTION_ORDER]);
  const tools = ev.filter((e) => e.type === "tool").map((e: any) => `${e.kind}:${e.text}`);
  assert.deepEqual(tools.sort(), ["render:https://developer.acme.io/oauth", "search:Acme OAuth", "skill:approval-programs"]);
  // The evidence was re-emitted after review with the lowered status
  const lastEvidence = ev.filter((e: any) => e.type === "section" && e.section === "evidence").pop() as any;
  assert.equal(lastEvidence.data.evidence[0].status, "secondary");
  const sc = ev.find((e) => e.type === "selfcheck") as any;
  assert.deepEqual(sc.counts, { docs: 1, secondary: 2, conflict: 0, unverified: 0 });
  assert.ok(sc.notes.some((n: string) => n.includes("lowered the status of 1")));
  assert.ok(sc.notes.some((n: string) => n.includes("forum")));
  const header = (ev.find((e: any) => e.section === "header") as any).data;
  assert.equal(header.slug, "acme");
  assert.equal(header.evidenceLevel, "generated");
  assert.ok(ev.some((e: any) => e.type === "stage" && e.stage === "selfcheck" && e.state === "done"));
});

test("research: a failed review still finishes with rule checks", async () => {
  const f = installFake([message([{ text: guideLines("Acme") }]), new Response("overloaded", { status: 529 })]);
  const ev: AgentEvent[] = [];
  await researchGuide({ name: "Acme", website: "acme.io" }, (e) => ev.push(e));
  f.restore();
  const sc = ev.find((e) => e.type === "selfcheck") as any;
  assert.ok(sc.notes.some((n: string) => n.includes("didn't finish")));
});

test("research: a vendor without OAuth stops after header and evidence, with no review call", async () => {
  const lines = [
    JSON.stringify({ section: "header", data: { name: "KeyOnly", website: "keyonly.com", category: "x", oauth: { supported: false, note: "API keys per account." }, verdict: "No OAuth app to create." } }),
    JSON.stringify({ section: "evidence", data: { evidence: [{ claim: "API keys only", status: "docs", basis: "Auth page" }], sources: [{ title: "Auth", url: "https://keyonly.com/docs/auth" }] } }),
  ].join("\n");
  const f = installFake([message([{ text: lines }])]);
  const ev: AgentEvent[] = [];
  await researchGuide({ name: "KeyOnly", website: "keyonly.com" }, (e) => ev.push(e));
  f.restore();
  assert.equal(f.calls.length, 1, "no second review for a no-OAuth guide");
  assert.deepEqual(ev.filter((e) => e.type === "section").map((e: any) => e.section), ["header", "evidence"]);
});

test("research: no guide at all is an error, not an empty success", async () => {
  const f = installFake([message([{ text: "I could not find anything useful." }])]);
  await assert.rejects(researchGuide({ name: "Nope", website: "" }, () => {}), /stopped without writing a guide/);
  f.restore();
});

test("research mock mode streams a full guide and a self-check without calling the API", async () => {
  process.env.AGENT_MOCK = "1"; delete process.env.ANTHROPIC_API_KEY;
  const f = installFake([]);
  const ev: AgentEvent[] = [];
  await researchGuide({ name: "Calendly", website: "calendly.com" }, (e) => ev.push(e));
  f.restore();
  assert.equal(f.calls.length, 0);
  assert.equal(ev.filter((e) => e.type === "section").length, 14);
  assert.ok(ev.some((e) => e.type === "selfcheck"));
});

// ---------- Chat ----------
test("cleanMessages trims, merges repeated roles, drops leading assistant turns and rejects bad input", () => {
  assert.equal(cleanMessages(null), null);
  assert.equal(cleanMessages([]), null);
  assert.equal(cleanMessages([{ role: "assistant", content: "hi" }]), null);
  assert.equal(cleanMessages([{ role: "user", content: "q" }, { role: "assistant", content: "a" }]), null, "must end with the user");
  assert.deepEqual(cleanMessages([{ role: "assistant", content: "x" }, { role: "user", content: "a" }, { role: "user", content: "b" }, { role: "system", content: "evil" }, { role: "user", content: "  " }]), [{ role: "user", content: "a\n\nb" }]);
  const long = cleanMessages(Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "x".repeat(5000) })).concat([{ role: "user", content: "last" }]))!;
  assert.ok(long.length <= 12);
  assert.ok(long.every((m) => m.content.length <= 8002));
});

test("chat system prompt includes the library index, the current guide and permission rules", async () => {
  const s = chatSystem(await listGuides(), linear);
  assert.match(s, /slack: Slack/);
  assert.match(s, /reading the Linear guide/);
  assert.match(s, /Anything that writes needs the developer's approval/);
  assert.match(s, /answering-questions|Answering questions/);
  assert.match(chatSystem(await listGuides(), null), /library page/);
});

test("chat tools: reads, searches, proposes research, and proposes (never performs) writes", async () => {
  const ev: ChatEvent[] = [];
  const tools = chatTools((e) => ev.push(e));
  const run = (n: string, i: Record<string, unknown>) => tools.find((t) => t.name === n)!.run(i);

  assert.match(await run("search_library", { query: "messag" }), /slack/);
  assert.match(await run("search_library", { query: "zzz" }), /No guide matches/);
  const g = JSON.parse(await run("read_guide", { slug: "Slack", sections: ["limits", "bogus"] }));
  assert.ok(g.limits && !g.bogus && g.evidence);
  assert.match(await run("read_guide", { slug: "calendly" }), /No guide with slug/);
  assert.match(await run("identify_vendor", { query: "sfdc" }), /"inLibrary":"salesforce"/);

  await run("propose_research", { name: "Calendly", website: "https://www.calendly.com/x" });
  assert.match(await run("propose_research", { name: "" }), /required/);

  assert.match(await run("save_correction", { slug: "slack", section: "limits", claim: "1 req/min", correction: "2 req/min", source: "https://api.slack.com/changelog" }), /Nothing is saved unless they click Approve/);
  assert.match(await run("save_correction", { slug: "slack" }), /required/);
  assert.deepEqual(await listCorrections("slack"), [], "the agent can't write by itself");

  const actions = ev.filter((e) => e.type === "action").map((e: any) => e.action);
  assert.deepEqual(actions[0], { kind: "research", name: "Calendly", website: "calendly.com" });
  assert.equal(actions[1].kind, "approve");
  assert.equal(actions[1].payload.correction, "2 req/min");
  assert.ok(ev.some((e: any) => e.type === "tool" && e.kind === "read"));
});

test("chat: the model reads another guide to compare, then answers with citations", async () => {
  const f = installFake([
    (body) => {
      assert.match(body.system, /reading the Slack guide/);
      assert.deepEqual(body.tools.map((t: any) => t.name), ["web_search", "web_fetch", "search_library", "read_guide", "identify_vendor", "propose_research", "save_correction", "load_skill"]);
      return message([{ text: "Checking Linear." }, { tool: "read_guide", input: { slug: "linear", sections: ["approval"] } }], "tool_use");
    },
    (body) => {
      assert.match(body.messages[2].content[0].content, /"slug":"linear"/);
      return message([{ text: "Linear needs no review [§07 linear]; Slack needs a listing [§07]." }]);
    },
  ]);
  const ev: ChatEvent[] = [];
  await runChat({ slug: "slack", messages: [{ role: "user", content: "Compare with Linear" }] }, (e) => ev.push(e));
  f.restore();
  const text = ev.filter((e) => e.type === "text").map((e: any) => e.delta).join("");
  assert.match(text, /Checking Linear\.\nLinear needs no review \[§07 linear\]/);
  assert.ok(ev.some((e: any) => e.type === "tool" && e.text.includes("Linear")));
});

test("chat mock mode covers answers, research offers and approvals", async () => {
  process.env.AGENT_MOCK = "1"; delete process.env.ANTHROPIC_API_KEY;
  const f = installFake([]);
  const collect = async (slug: string | undefined, q: string) => { const ev: ChatEvent[] = []; await runChat({ slug, messages: [{ role: "user", content: q }] }, (e) => ev.push(e)); return ev; };
  assert.ok((await collect("slack", "how long?")).some((e: any) => e.type === "text" && /§08 slack/.test(e.delta)));
  assert.ok((await collect(undefined, "What about Calendly?")).some((e: any) => e.type === "action" && e.action.kind === "research" && e.action.name === "Calendly"));
  assert.ok((await collect("slack", "this limit is wrong")).some((e: any) => e.type === "action" && e.action.kind === "approve"));
  f.restore();
  assert.equal(f.calls.length, 0);
});
