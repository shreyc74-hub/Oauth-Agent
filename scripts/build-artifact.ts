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
.shell{padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}
.top nav a{cursor:pointer}
`;

const tone = (n: number) => (n <= 2 ? "g" : n === 3 ? "a" : "r");
const meter = (n: number) => `<span class="meter m-${tone(n)}">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= n ? "on" : ""}"></i>`).join("")}</span>`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const EV = { tested: "Tested", docs: "Docs-checked", generated: "Generated" } as const;

const cards = guides.map((g) => `
  <a class="card" href="#g-${g.slug}">
    <div class="row"><h3>${esc(g.name)}</h3><span class="cat">${esc(g.category)}</span></div>
    <div class="meters"><span>Create</span><span>${meter(g.glance.creation.rating)}</span><span>Approve</span><span>${meter(g.glance.approval.rating)}</span></div>
    <p>${esc(g.verdict)}</p>
    <div class="foot"><span>Wait: ${esc(g.glance.waiting.value)}</span><span class="badge ev-${g.evidenceLevel}">${EV[g.evidenceLevel]}</span></div>
  </a>`).join("");

const views = guides.map((g) => `
  <div class="view" id="v-${g.slug}" hidden>
    <a class="small" href="#library">&larr; All guides</a>
    <div class="toolbar">
      <button class="btn" type="button" data-md="${g.slug}">Download Markdown</button>
      <button class="btn" type="button" data-copy="${g.slug}">Copy as Markdown</button>
      <span class="toast" role="status"></span>
    </div>
    ${renderToStaticMarkup(React.createElement(GuideView, { g }))}
  </div>`).join("");

const md = Object.fromEntries(guides.map((g) => [g.slug, toMarkdown(g)]));

const html = `<title>OAuth Readiness Guides</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;700&display=swap">
<style>${css}</style>
<div class="shell">
  <header class="top">
    <a class="brand" href="#library"><b>OAuth Readiness</b><span>for agent builders on Composio</span></a>
    <nav><a href="#library">Library</a></nav>
  </header>
  <main>
    <div class="view" id="v-library">
      <section class="hero">
        <div class="eyebrow">Provider OAuth apps · ${guides.length} guides</div>
        <h1>How long until your users can connect?</h1>
        <p class="lede">Each guide shows whether you need your own OAuth app, which choices you can't undo, what stays capped until review, how long approval takes, and which steps an agent can do for you. Five were tested by creating a real app.</p>
        <div class="panel"><b>Looking for another app?</b> ${SITE ? `The live research agent runs on the full site: <a href="${SITE}" target="_blank" rel="noopener">${esc(SITE.replace(/^https?:\/\//, ""))}</a>. It identifies the vendor, checks the library, then researches official docs and streams a new guide.` : "The live research agent runs on the deployed web app, where it researches official docs and streams a new guide."}</div>
      </section>
      <div class="sectionhead"><h2>Library</h2><span class="small">Tested = we created a real app · Docs-checked = verified against official docs</span></div>
      <div class="grid">${cards}</div>
    </div>
    ${views}
  </main>
  <footer class="foot">Guides marked Tested were checked by creating a real app on Oct 28, 2026. Each claim carries a status: tested, official docs, secondary source, conflict or not verified.</footer>
</div>
<script id="md-data" type="application/json">${JSON.stringify(md).replace(/<\//g, "<\\/")}</script>
<script>
(function () {
  var MD = JSON.parse(document.getElementById("md-data").textContent);
  function show() {
    var h = (location.hash || "").slice(1);
    var id = h.indexOf("g-") === 0 && document.getElementById("v-" + h.slice(2)) ? "v-" + h.slice(2) : "v-library";
    document.querySelectorAll(".view").forEach(function (v) { v.hidden = v.id !== id; });
    window.scrollTo(0, 0);
  }
  window.addEventListener("hashchange", show); show();

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

  function toast(btn, t) { var el = btn.parentElement.querySelector(".toast"); if (el) { el.textContent = t; setTimeout(function () { if (el.textContent === t) el.textContent = ""; }, 2500); } }
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
        b.parentElement.after(ta); ta.select(); toast(b, "Select and copy the text below");
      });
    });
  });
})();
</script>`;

fs.mkdirSync(path.join(root, "dist"), { recursive: true });
fs.writeFileSync(path.join(root, "dist/artifact.html"), html);
console.log(`dist/artifact.html: ${guides.length} guides, ${(html.length / 1024).toFixed(0)} KB`);
