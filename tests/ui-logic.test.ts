// Pure UI logic: library filters, chat citation parsing, research event reducer, TOC and suggestions,
// plus a server render of every library guide to catch crashes in the guide layout.
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { applyFilter } from "../components/LibraryTable";
import { parseCites } from "../components/ChatPanel";
import { applyEvent, initialStages, type RunState } from "../components/ResearchView";
import { tocFor, suggestionsFor } from "../components/GuidePage";
import GuideView from "../components/GuideView";
import { researchHref } from "../components/Explorer";
import { libraryGuides } from "../lib/library";
import { summarize } from "../lib/store";

const rows = libraryGuides().map(summarize);

test("library filters", () => {
  const names = (f: Parameters<typeof applyFilter>[1], c = "all") => applyFilter(rows, f, c).map((r) => r.slug).sort();
  assert.equal(names("all").length, 8);
  assert.deepEqual(names("noreview"), rows.filter((r) => r.approval <= 2).map((r) => r.slug).sort());
  assert.ok(names("noreview").includes("linear") && !names("noreview").includes("gmail"));
  assert.ok(names("week").length >= names("noreview").length);
  assert.ok(!names("week").includes("slack"), "Slack's Marketplace review is weeks");
  assert.deepEqual(names("tested"), ["confluence", "gmail", "linear", "notion", "slack"]);
  const cat = rows[0].category;
  assert.ok(names("all", cat).length >= 1 && names("all", cat).every((s) => rows.find((r) => r.slug === s)!.category === cat));
  assert.deepEqual(names("all", "No such category"), []);
  const noOauth = { ...rows[0], slug: "keys", oauthSupported: false, approval: 0 };
  assert.deepEqual(applyFilter([noOauth], "noreview", "all"), [], "no-OAuth apps aren't 'no review needed'");
});

test("parseCites turns [§NN slug] markers into links and leaves other brackets alone", () => {
  const p = parseCites("Capped [§08 slack], see [§7] and [§99] or [note].");
  assert.deepEqual(p.map((x) => x.t), ["text", "cite", "text", "cite", "text"]);
  assert.deepEqual(p[1], { t: "cite", num: "08", key: "limits", slug: "slack" });
  assert.deepEqual(p[3], { t: "cite", num: "07", key: "approval", slug: undefined });
  assert.equal((p[4] as any).v, " and [§99] or [note].");
  assert.deepEqual(parseCites("plain"), [{ t: "text", v: "plain" }]);
  assert.deepEqual(parseCites(""), []);
});

test("research reducer: sections fill in, skipped stages are marked honestly, budgets count", () => {
  let s: RunState = { guide: {}, stages: initialStages(), lines: [], counts: { search: 0, fetch: 0 } };
  s = applyEvent(s, { type: "stage", stage: "oauth", state: "active" });
  s = applyEvent(s, { type: "tool", kind: "search", text: "q" });
  s = applyEvent(s, { type: "tool", kind: "fetch", text: "u" });
  s = applyEvent(s, { type: "tool", kind: "render", text: "u" });
  s = applyEvent(s, { type: "tool", kind: "skill", text: "scope-risk" });
  s = applyEvent(s, { type: "stage", stage: "write", state: "active" });
  assert.equal(s.stages.oauth, "done");
  assert.equal(s.stages.docs, "skipped");
  assert.equal(s.stages.write, "active");
  assert.deepEqual(s.counts, { search: 1, fetch: 2 });
  s = applyEvent(s, { type: "section", section: "header", data: { name: "Acme", evidenceLevel: "tested" } });
  s = applyEvent(s, { type: "section", section: "glance", data: { a: 1 } });
  s = applyEvent(s, { type: "section", section: "evidence", data: { evidence: [{ claim: "x" }], sources: [] } });
  assert.equal(s.guide.name, "Acme");
  assert.equal(s.guide.evidenceLevel, "generated", "never tested in the browser either");
  assert.deepEqual((s.guide as any).glance, { a: 1 });
  assert.equal(s.guide.evidence!.length, 1);
  s = applyEvent(s, { type: "oauth", supported: true, note: "OAuth 2.0" });
  assert.deepEqual(s.oauth, { supported: true, note: "OAuth 2.0" });
  s = applyEvent(s, { type: "selfcheck", counts: { docs: 1 }, notes: ["n"] });
  assert.deepEqual(s.selfcheck, { counts: { docs: 1 }, notes: ["n"] });
  for (let i = 0; i < 100; i++) s = applyEvent(s, { type: "status", text: String(i) });
  assert.equal(s.lines.length, 60, "activity log is bounded");
});

test("TOC lists present sections; a no-OAuth guide shows only evidence", () => {
  const slack = libraryGuides().find((g) => g.slug === "slack")!;
  assert.equal(tocFor(slack).length, 13);
  assert.deepEqual(tocFor({ ...slack, oauth: { supported: false } }), ["evidence"]);
});

test("chat suggestions fit the guide", () => {
  const slack = libraryGuides().find((g) => g.slug === "slack")!;
  const s = suggestionsFor(slack, [{ slug: "slack", name: "Slack" }, { slug: "linear", name: "Linear" }]);
  assert.equal(s.length, 3);
  assert.ok(s.includes("Compare with Linear"));
  assert.ok(!s.some((x) => x.includes("Compare with Slack")));
  assert.equal(suggestionsFor({ ...slack, oauth: { supported: false } }, []).length, 1);
});

test("researchHref encodes the vendor", () => {
  assert.equal(researchHref({ name: "monday.com Work & Co", website: "monday.com" }, true), "/research?name=monday.com+Work+%26+Co&website=monday.com&overwrite=1");
});

test("every library guide renders, and a half-streamed guide renders with placeholders", () => {
  for (const g of libraryGuides()) {
    const html = renderToStaticMarkup(React.createElement(GuideView, { g }));
    assert.ok(html.includes(`id="s-limits"`), g.slug);
    assert.ok(!html.includes("undefined"), `${g.slug} renders "undefined"`);
  }
  const partial = renderToStaticMarkup(React.createElement(GuideView, { g: { name: "Acme", verdict: "v", oauth: { supported: true } }, streaming: true }));
  assert.ok(partial.includes("Writing…"));
  assert.ok(partial.includes("Waiting"));
  const none = renderToStaticMarkup(React.createElement(GuideView, { g: { name: "Keys", verdict: "v", oauth: { supported: false, note: "API keys" }, evidence: [], sources: [] } }));
  assert.ok(none.includes("No OAuth found"));
  assert.ok(!none.includes(`id="s-glance"`));
});
