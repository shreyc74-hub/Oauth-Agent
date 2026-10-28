// Library content, schema validation, markdown export and skills.
import { test } from "node:test";
import assert from "node:assert/strict";
import { libraryGuides, matchLibrary, slugify, ALIASES } from "../lib/library";
import { validateGuide, SECTION_ORDER, SECTION_TITLES, type Guide } from "../lib/schema";
import { toMarkdown } from "../lib/markdown";
import { allSkills, getSkill, parseSkill, skillIndex, skillTool } from "../lib/agent/skills";
import { RESEARCH_SKILLS } from "../lib/agent/research";
import { CHAT_SKILLS } from "../lib/agent/chat";
import fs from "node:fs";
import path from "node:path";

const guides = libraryGuides();

test("library has the 8 agreed guides: 5 tested, 3 docs-checked", () => {
  assert.deepEqual(guides.map((g) => g.slug).sort(), ["confluence", "gmail", "hubspot", "linear", "linkedin", "notion", "salesforce", "slack"]);
  assert.equal(guides.filter((g) => g.evidenceLevel === "tested").length, 5);
  assert.equal(guides.filter((g) => g.evidenceLevel === "docs").length, 3);
});

test("every library guide passes validation and has all 14 sections", () => {
  for (const g of guides) {
    assert.deepEqual(validateGuide(g), [], g.slug);
    for (const k of SECTION_ORDER) if (k !== "header" && k !== "evidence") assert.ok((g as any)[k] !== undefined, `${g.slug} missing ${k}`);
    assert.ok(g.sources.length >= 2, `${g.slug} sources`);
    assert.equal(g.limits.ladder.length, 3, `${g.slug} ladder`);
    for (const s of g.steps) assert.ok(["agent", "you", "waiting"].includes(s.owner), `${g.slug} owner ${s.owner}`);
    for (const s of g.sources) assert.match(s.url, /^https?:\/\//, `${g.slug} source url`);
    assert.ok(!/—/.test(JSON.stringify(g)), `${g.slug} contains an em dash`);
  }
});

test("docs-checked guides never claim tested evidence", () => {
  for (const g of guides.filter((x) => x.evidenceLevel !== "tested")) {
    assert.ok(!g.evidence.some((e) => e.status === "tested"), g.slug);
  }
});

test("bundled content matches the files on disk", () => {
  const files = fs.readdirSync(path.join(__dirname, "..", "data", "guides")).filter((f) => f.endsWith(".json"));
  assert.equal(files.length, guides.length);
  for (const f of files) {
    const disk = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "guides", f), "utf8"));
    assert.deepEqual(guides.find((g) => g.slug === disk.slug), disk, f);
  }
});

test("validateGuide catches broken guides", () => {
  assert.ok(validateGuide({}).length >= 3);
  const g = structuredClone(guides[0]) as Partial<Guide>;
  assert.deepEqual(validateGuide(g), []);
  assert.ok(validateGuide({ ...g, slug: "Bad Slug!" }).some((p) => p.includes("slug")));
  assert.ok(validateGuide({ ...g, steps: [] }).some((p) => p.includes("steps")));
  assert.ok(validateGuide({ ...g, limits: { ladder: [], notes: [] } }).some((p) => p.includes("ladder")));
  assert.ok(validateGuide({ ...g, oauth: undefined }).some((p) => p.includes("oauth")));
  // A no-OAuth guide only needs the header
  assert.deepEqual(validateGuide({ slug: "acme", name: "Acme", verdict: "No OAuth.", oauth: { supported: false, note: "API keys" } }), []);
});

test("matchLibrary finds names, aliases, domains and links, without false positives", () => {
  const hit = (q: string) => matchLibrary(q, guides)?.slug ?? null;
  assert.equal(hit("Slack"), "slack");
  assert.equal(hit("  SLACK  "), "slack");
  assert.equal(hit("https://www.slack.com/"), "slack");
  assert.equal(hit("slack.com/apps"), "slack");
  assert.equal(hit("sfdc"), "salesforce");
  assert.equal(hit("google mail"), "gmail");
  assert.equal(hit("linear.app"), "linear");
  assert.equal(hit("Atlassian Confluence"), "confluence");
  assert.equal(hit("slackbot"), null);
  assert.equal(hit("notionist"), null);
  assert.equal(hit(""), null);
  assert.equal(hit("monday"), null);
  for (const slug of Object.keys(ALIASES)) assert.ok(guides.some((g) => g.slug === slug), `alias for unknown slug ${slug}`);
});

test("slugify handles names, links and junk", () => {
  assert.equal(slugify("monday.com"), "monday");
  assert.equal(slugify("https://www.calendly.com/pricing"), "calendly");
  assert.equal(slugify("Microsoft Teams"), "microsoft-teams");
  assert.equal(slugify("  Zoho CRM!! "), "zoho-crm");
  assert.equal(slugify("linear.app"), "linear");
  assert.equal(slugify("€€€"), "");
  assert.equal(slugify("a".repeat(100)).length, 60);
});

test("markdown export has every section heading and no undefined values", () => {
  for (const g of guides) {
    const md = toMarkdown(g);
    assert.ok(md.startsWith(`# ${g.name}`), g.slug);
    for (const k of Object.keys(SECTION_TITLES)) assert.ok(md.includes(SECTION_TITLES[k].title), `${g.slug} md missing ${k}`);
    assert.ok(!md.includes("undefined"), `${g.slug} md has undefined`);
    assert.ok(!md.includes("[object Object]"), `${g.slug} md has [object Object]`);
  }
});

test("markdown export of a no-OAuth guide says so and still lists evidence", () => {
  const md = toMarkdown({ slug: "acme", name: "Acme", website: "acme.com", category: "x", oauth: { supported: false, note: "Uses API keys." }, evidenceLevel: "generated", checkedOn: "2026-10-28", verdict: "No OAuth app to create.", evidence: [{ claim: "API keys only", status: "docs", basis: "Docs" }], sources: [{ title: "Docs", url: "https://acme.com/docs" }] } as unknown as Guide);
  assert.match(md, /No OAuth found/);
  assert.match(md, /API keys only/);
  assert.ok(!md.includes("undefined"));
});

// ---------- Skills ----------
test("every skill has a name matching its folder and a description", () => {
  const dirs = fs.readdirSync(path.join(__dirname, "..", "skills"));
  const skills = allSkills();
  assert.equal(skills.length, dirs.length);
  for (const s of skills) {
    assert.ok(dirs.includes(s.name), `skill ${s.name} folder`);
    assert.ok(s.description.length > 20, `${s.name} description`);
    assert.ok(s.body.length > 200, `${s.name} body`);
    assert.ok(!/—/.test(s.body), `${s.name} has an em dash`);
  }
});

test("every skill the agents reference exists", () => {
  for (const n of [...RESEARCH_SKILLS, ...CHAT_SKILLS, "vendor-identification"]) assert.ok(getSkill(n), n);
});

test("parseSkill reads frontmatter and tolerates files without it", () => {
  assert.deepEqual(parseSkill("---\nname: x\ndescription: does y: and z\n---\nBody"), { name: "x", description: "does y: and z", body: "Body" });
  assert.deepEqual(parseSkill("Just text", "dir"), { name: "dir", description: "", body: "Just text" });
});

test("skill index lists only the allowed skills", () => {
  const idx = skillIndex(["scope-risk"]);
  assert.match(idx, /scope-risk/);
  assert.ok(!idx.includes("no-oauth"));
});

test("load_skill tool loads, refuses unknown and disallowed skills", async () => {
  const loaded: string[] = [];
  const t = skillTool((n) => loaded.push(n), ["scope-risk"]);
  assert.match(await t.run({ name: "scope-risk" }), /# Skill: scope-risk/);
  assert.match(await t.run({ name: "Scope-Risk " }), /# Skill: scope-risk/);
  assert.match(await t.run({ name: "no-oauth" }), /No skill called/);
  assert.match(await t.run({ name: "" }), /No skill called/);
  assert.deepEqual(loaded, ["scope-risk", "scope-risk"]);
});

// ---------- Environment names ----------
import { normalizeEnv } from "../lib/env";
test("environment variables work in any case, with or without underscores", () => {
  const env: Record<string, string | undefined> = { anthropic_api_Key: "a", supabaseurl: " https://x.supabase.co ", supabase_service_role_key: "s", GUIDE_MODEL: "keep" , guide_model: "ignored" };
  const filled = normalizeEnv(env);
  assert.equal(env.ANTHROPIC_API_KEY, "a");
  assert.equal(env.SUPABASE_URL, "https://x.supabase.co");
  assert.equal(env.SUPABASE_SERVICE_ROLE_KEY, "s");
  assert.equal(env.GUIDE_MODEL, "keep", "an exact name always wins");
  assert.deepEqual(filled.sort(), ["ANTHROPIC_API_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_URL"]);
  const e2: Record<string, string | undefined> = { Supabase_Secret_Key: "sk", empty_key: "" };
  normalizeEnv(e2);
  assert.equal(e2.SUPABASE_SERVICE_ROLE_KEY, "sk");
  assert.equal(e2.ANTHROPIC_API_KEY, undefined);
});
