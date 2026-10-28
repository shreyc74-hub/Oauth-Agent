// Browser click-through test.
//   Mock (full flow, free):  AGENT_MOCK=1 AGENT_MOCK_FAST=1 npm run build && npm start, then  npm run e2e
//   Live smoke (deployed):   E2E_URL=https://your-app.vercel.app npm run e2e
//   Live with one research:  E2E_URL=... E2E_RESEARCH=Calendly npm run e2e   (one real research run, about 2-4 min)
// Needs Playwright: npm i -D playwright && npx playwright install chromium
const { chromium } = require("playwright");

const BASE = (process.env.E2E_URL || process.env.E2E_LOCAL || "http://localhost:3000").replace(/\/$/, "");
const live = Boolean(process.env.E2E_URL);
const results = [];
async function check(name, fn) {
  const t = Date.now();
  try { await fn(); results.push(["ok", name, Date.now() - t]); console.log(`ok   ${name}`); }
  catch (e) { results.push(["FAIL", name]); console.log(`FAIL ${name}\n     ${String(e.message).split("\n")[0]}`); }
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

(async () => {
  const b = await chromium.launch();
  const page = await b.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await check("home shows the library with filters", async () => {
    await page.goto(BASE + "/");
    await page.waitForSelector("a.lrow");
    expect((await page.locator("a.lrow").count()) >= 8, "fewer than 8 library rows");
    await page.click("text=Tested only");
    expect((await page.locator("a.lrow").count()) === 5, "Tested only should show 5");
    await page.click("button.seg:has-text('All')");
  });

  await check("exact name opens the library guide without research", async () => {
    await page.fill("#app-query", "Slack");
    await page.click("button:has-text('Find guide')");
    await page.waitForURL("**/guides/slack", { timeout: 15000 });
    await page.waitForSelector("#s-approval");
  });

  await check("guide page has the section menu, downloads and chat", async () => {
    expect(await page.locator("nav.toc a").count() === 9, "TOC should list 9 sections");
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click("button:has-text('Markdown')")]);
    expect(dl.suggestedFilename() === "slack-oauth-readiness.md", "markdown filename");
    expect(await page.locator(".chat input").count() === 1, "chat input missing");
  });

  await check("Markdown API and 404", async () => {
    const md = await page.request.get(BASE + "/api/guides/slack?format=md");
    expect(md.ok() && (await md.text()).startsWith("# Slack"), "markdown API");
    const nf = await page.request.get(BASE + "/guides/does-not-exist");
    expect(nf.status() === 404, "404 page");
  });

  await check("rough name asks which app you mean", async () => {
    await page.goto(BASE + "/");
    await page.click("button.chip:has-text('monday')");
    await page.waitForSelector("text=Which app do you mean?", { timeout: 60000 });
  });

  await check("chat answers about the guide with tools and citations", async () => {
    await page.goto(BASE + "/guides/slack");
    await page.click(".chat .sugg .chip >> nth=0");
    await page.waitForSelector(".chat .bot p", { timeout: 90000 });
    await page.waitForFunction(() => !document.querySelector(".chat form button.btn:not(.primary)"), null, { timeout: 90000 });
    const txt = await page.locator(".chat .bot").last().innerText();
    expect(txt.length > 40, "answer too short");
  });

  if (!live) {
    await check("mock: chat proposes a correction and saves only after Approve", async () => {
      await page.fill(".chat input", "This limit is wrong");
      await page.click(".chat form button.primary");
      await page.waitForSelector(".act.approve button:has-text('Approve')");
      const before = await (await page.request.get(BASE + "/api/corrections?slug=slack")).json();
      await page.click(".act.approve button:has-text('Approve')");
      await page.waitForSelector("text=Saved for review");
      const after = await (await page.request.get(BASE + "/api/corrections?slug=slack")).json();
      expect(after.length === before.length + 1, "correction not saved after approval");
    });
  }

  const research = process.env.E2E_RESEARCH || (live ? "" : "Calendly");
  if (research) {
    await check(`research ${research}: live steps, guide streams in, save asks first`, async () => {
      await page.goto(`${BASE}/research?name=${encodeURIComponent(research)}&website=${encodeURIComponent(research.toLowerCase() + ".com")}`);
      await page.waitForSelector(".rstep.active, .rstep.done >> nth=2", { timeout: 30000 });
      await page.waitForSelector("text=Save this guide to the library?", { timeout: 300000 });
      expect(await page.locator("section.gs").count() >= 2, "guide sections missing");
      if (!live) {
        await page.click("button:has-text('Save to library')");
        await page.waitForSelector("text=Saved to the library.");
      }
    });
  }

  await check("phone width: no sideways scrolling", async () => {
    const m = await b.newPage({ viewport: { width: 390, height: 844 } });
    for (const u of ["/", "/guides/gmail", "/ask", "/how-it-works"]) {
      await m.goto(BASE + u);
      const w = await m.evaluate(() => document.documentElement.scrollWidth);
      expect(w <= 391, `${u} is ${w}px wide`);
    }
    await m.close();
  });

  await check("no JavaScript errors on any page", async () => { expect(errors.length === 0, errors.join(" | ")); });

  await b.close();
  const failed = results.filter((r) => r[0] === "FAIL").length;
  console.log(`\n${results.length - failed} passed, ${failed} failed  (${BASE}${live ? ", live" : ", mock"})`);
  process.exit(failed ? 1 : 0);
})();
