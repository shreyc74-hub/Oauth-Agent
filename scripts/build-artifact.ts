// Builds dist/artifact.html: a single-file, shareable preview of the library that uses the exact
// same guide layout (server-rendered GuideView) as the web app.
// Usage: npx tsx --tsconfig tsconfig.scripts.json scripts/build-artifact.ts
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import GuideView from "../components/GuideView";
import { libraryGuides } from "../lib/library";
import { toMarkdown } from "../lib/markdown";
import { SECTION_TITLES } from "../lib/schema";

const root = path.join(__dirname, "..");
const guides = libraryGuides();
const SITE = process.env.SITE_URL || ""; // deployed app URL, shown as the place for live research

// Artifact theming contract: light tokens on :root, dark tokens under two guarded selectors.
let css = fs.readFileSync(path.join(root, "app/globals.css"), "utf8");
const darkStart = css.indexOf("@media (prefers-color-scheme: dark) {");
const darkEnd = css.indexOf("}\n}", darkStart) + 3;
const darkBody = css.slice(darkStart, darkEnd).replace("@media (prefers-color-scheme: dark) {", "").trim().replace(/^:root\s*\{/, "").replace(/\}\s*\}$/, "").trim();
css = css.slice(0, darkStart) +
  `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${darkBody} } }\n:root[data-theme="dark"] { ${darkBody} }\n` +
  css.slice(darkEnd);
css += `
.view[hidden]{display:none!important}
.site{position:static}
.lrow[hidden]{display:none!important}
.wrap{padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}
.livebox{margin-top:24px;max-width:760px;padding:16px 20px;border-radius:14px;background:var(--accent-soft);font-size:15px}
.gpage.nochat{grid-template-columns:230px minmax(0,1fr)}
.toc{top:0}
@media (max-width:860px){.gpage.nochat{grid-template-columns:minmax(0,1fr)}}
`;

const tone = (n: number) => (n <= 2 ? "g" : n === 3 ? "a" : "r");
const meter = (n: number) => `<span class="meter m-${tone(n)}">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= n ? "on" : ""}"></i>`).join("")}</span>`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const EV = { tested: "Tested", docs: "Docs-checked", generated: "Generated" } as const;
const cats = [...new Set(guides.map((g) => g.category))].sort();

const rows = guides.map((g) => `
  <a class="lrow" href="#g-${g.slug}" data-approval="${g.glance.approval.rating}" data-ev="${g.evidenceLevel}" data-cat="${esc(g.category)}">
    <span><span class="nm">${esc(g.name)}</span><span class="dm">${esc(g.website)}</span></span>
    <span>${meter(g.glance.creation.rating)}</span><span>${meter(g.glance.approval.rating)}</span>
    <span class="w">${esc(g.glance.waiting.value)}</span>
    <span>${esc((g.oneWayDoors[0]?.title ?? "").replace(/`/g, ""))}</span>
    <span><span class="badge ev-${g.evidenceLevel}">${EV[g.evidenceLevel]}</span></span>
  </a>`).join("");

const live = (what: string) => SITE ? `<a href="${SITE}" target="_blank" rel="noopener">${what}</a>` : what;
const views = guides.map((g) => {
  const keys = Object.keys(SECTION_TITLES).filter((k) => (g as unknown as Record<string, unknown>)[k] !== undefined);
  return `
  <div class="view" id="v-${g.slug}" hidden>
    <div class="subbar"><div class="in">
      <div class="crumbs"><a href="#library">Library</a><span class="sep">/</span><b>${esc(g.name)}</b></div>
      <div class="toolbar"><span class="toast" role="status"></span>
        <button class="btn" type="button" data-md="${g.slug}">Markdown</button>
        <button class="btn" type="button" data-copy="${g.slug}">Copy as Markdown</button>
        ${SITE ? `<a class="btn primary" href="${SITE}/guides/${g.slug}" target="_blank" rel="noopener">Ask about ${esc(g.name)}</a>` : ""}
      </div>
    </div></div>
    <div class="gpage nochat">
      <nav class="toc" aria-label="Sections"><div class="t">On this page</div>${keys.map((k) => `<a href="#g-${g.slug}/${k}" data-sec="s-${k}"><span>${SECTION_TITLES[k].num}</span>${SECTION_TITLES[k].title}</a>`).join("")}</nav>
      <main class="gmain">${renderToStaticMarkup(React.createElement(GuideView, { g }))}</main>
    </div>
  </div>`;
}).join("");

const md = Object.fromEntries(guides.map((g) => [g.slug, toMarkdown(g)]));

const html = `<title>OAuth Readiness Guides</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600;700&display=swap">
<style>${css}</style>
<header class="site"><div class="wrap">
  <a class="brand" href="#library"><b>OAuth Readiness</b><span>for agent builders on Composio</span></a>
  <nav aria-label="Main"><a href="#library" aria-current="page">Library</a>${SITE ? `<a class="cta" href="${SITE}/ask" target="_blank" rel="noopener">Ask the agent</a>` : ""}</nav>
</div></header>
<div class="view" id="v-library"><div class="wrap">
  <section class="hero">
    <div class="eyebrow">Provider OAuth apps · ${guides.length} guides · ${guides.filter((g) => g.evidenceLevel === "tested").length} tested by creating real apps</div>
    <h1>How long until your users can connect?</h1>
    <p class="lede">Look up an app before you build. See which choices you can't undo, what stays capped until review, how long approval takes, and what an agent can do for you.</p>
    <div class="livebox"><b>Looking for another app?</b> ${SITE ? `The research agent runs on ${live("the full site")}: type any app name or link and it identifies the vendor, researches official docs and streams a new guide. Each guide there also has a chat.` : "The research agent and chat run on the deployed web app."}</div>
  </section>
  <section class="block">
    <div class="libhead"><h2>Library</h2>
      <div class="filters" role="group" aria-label="Filter the library">
        <button type="button" class="seg" aria-pressed="true" data-f="all">All ${guides.length}</button>
        <button type="button" class="seg" aria-pressed="false" data-f="noreview">No review needed</button>
        <button type="button" class="seg" aria-pressed="false" data-f="week">Live in under a week</button>
        <button type="button" class="seg" aria-pressed="false" data-f="tested">Tested only</button>
        <label class="sr" for="cat">Category</label>
        <select id="cat" class="seg"><option value="all">All categories</option>${cats.map((c) => `<option>${esc(c)}</option>`).join("")}</select>
      </div>
    </div>
    <div class="libtable"><div class="grid">
      <div class="lrow h" aria-hidden="true"><span>App</span><span>Create</span><span>Approve</span><span>Waiting</span><span>The trap to know first</span><span>Evidence</span></div>
      ${rows}
    </div></div>
  </section>
  <footer class="foot">Guides marked Tested were checked by creating a real app on Oct 28, 2026. Each claim carries a status: tested, official docs, secondary source, conflict or not verified.</footer>
</div></div>
${views}
<script id="md-data" type="application/json">${JSON.stringify(md).replace(/<\//g, "<\\/")}</script>
<script>
(function () {
  var MD = JSON.parse(document.getElementById("md-data").textContent);
  var current = "";
  function show() {
    var h = (location.hash || "").slice(1);
    var parts = h.indexOf("g-") === 0 ? h.slice(2).split("/") : [];
    var id = parts[0] && document.getElementById("v-" + parts[0]) ? "v-" + parts[0] : "v-library";
    if (id !== current) { document.querySelectorAll(".view").forEach(function (v) { v.hidden = v.id !== id; }); current = id; window.scrollTo(0, 0); }
    if (parts[1]) {
      var view = document.getElementById(id); var sec = view && view.querySelector("#s-" + parts[1]);
      if (sec) sec.scrollIntoView({ behavior: "smooth", block: "start" });
      view.querySelectorAll(".toc a").forEach(function (a) { a.classList.toggle("on", a.getAttribute("data-sec") === "s-" + parts[1]); });
    }
  }
  window.addEventListener("hashchange", show); show();

  // Library filters (same rules as the web app).
  var f = "all";
  function filter() {
    var cat = document.getElementById("cat").value;
    document.querySelectorAll("#v-library a.lrow").forEach(function (r) {
      var a = +r.getAttribute("data-approval"), ev = r.getAttribute("data-ev"), c = r.getAttribute("data-cat");
      var ok = (cat === "all" || c === cat) && (f === "all" || (f === "noreview" && a <= 2) || (f === "week" && a <= 3) || (f === "tested" && ev === "tested"));
      r.hidden = !ok;
    });
  }
  document.querySelectorAll("[data-f]").forEach(function (b) {
    b.addEventListener("click", function () { f = b.getAttribute("data-f"); document.querySelectorAll("[data-f]").forEach(function (x) { x.setAttribute("aria-pressed", x === b); }); filter(); });
  });
  document.getElementById("cat").addEventListener("change", filter);

  // Step filters (the static render has no React, so wire them here).
  document.querySelectorAll(".filters").forEach(function (group) {
    var buttons = group.querySelectorAll(".chip");
    var steps = group.parentElement.querySelectorAll("ol.steps li");
    var keys = ["all", "agent", "you", "waiting"];
    buttons.forEach(function (b, i) {
      b.addEventListener("click", function () {
        buttons.forEach(function (x) { x.setAttribute("aria-pressed", x === b); });
        steps.forEach(function (li) {
          var own = li.querySelector(".own"); var o = own ? own.className.replace(/.*own-/, "") : "";
          li.hidden = keys[i] !== "all" && o !== keys[i];
        });
      });
    });
  });

  function toast(btn, t) { var el = btn.closest(".toolbar").querySelector(".toast"); if (el) { el.textContent = t; setTimeout(function () { if (el.textContent === t) el.textContent = ""; }, 2500); } }
  var downloads = null;
  if (window.claude && window.claude.use) window.claude.use("downloads").then(function (d) { downloads = d; }).catch(function () {});
  document.querySelectorAll("[data-md]").forEach(function (b) {
    b.addEventListener("click", function () {
      var slug = b.getAttribute("data-md");
      if (!downloads) { toast(b, "Download isn't available here. Use Copy as Markdown."); return; }
      downloads.save({ filename: slug + "-oauth-readiness.md", data: new Blob([MD[slug]], { type: "text/markdown" }) })
        .then(function () { toast(b, "Saved"); }, function () { toast(b, "Download cancelled"); });
    });
  });
  document.querySelectorAll("[data-copy]").forEach(function (b) {
    b.addEventListener("click", function () {
      var text = MD[b.getAttribute("data-copy")];
      navigator.clipboard.writeText(text).then(function () { toast(b, "Markdown copied"); }, function () {
        var ta = document.createElement("textarea"); ta.value = text; ta.style.width = "100%"; ta.rows = 10;
        b.closest(".subbar").after(ta); ta.select(); toast(b, "Select and copy the text below");
      });
    });
  });
})();
</script>`;

fs.mkdirSync(path.join(root, "dist"), { recursive: true });
fs.writeFileSync(path.join(root, "dist/artifact.html"), html);
console.log(`dist/artifact.html: ${guides.length} guides, ${(html.length / 1024).toFixed(0)} KB`);
