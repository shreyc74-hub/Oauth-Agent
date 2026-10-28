// The research agent: checks OAuth support, researches live with web search, web fetch and a
// page renderer, loads skills as it needs them, streams the guide section by section, then runs
// a self-check. The model decides which tools to call and when; this file sets the goal, the
// tools, the skills and the output protocol.
import { runClaude, webTools, MAX_ROUNDS } from "./claude";
import { SECTION_ORDER, type Guide } from "../schema";
import { libraryGuides, slugify } from "../library";
import { createSectionParser, inferStage, type AgentEvent } from "./parse";
import { getSkill, skillIndex, skillTool } from "./skills";
import { renderProvider, renderTool } from "./render";
import { BUDGET } from "./budget";
import { ruleChecks, modelReview, applyReview, countStatuses } from "./selfcheck";

export type { AgentEvent } from "./parse";
export { BUDGET };

export const RESEARCH_SKILLS = ["oauth-research", "approval-programs", "scope-risk", "credential-handoff", "no-oauth", "js-pages"];

const SCHEMA = `
Output protocol. While researching, write a stage marker line before each stage, for example {"stage":"docs"}.
As soon as you know whether the vendor offers OAuth for third-party apps, write one line {"oauth":{"supported":true|false,"note":"under 12 words, e.g. OAuth 2.0 authorization code for public apps"}}.
When you have researched, write the guide as JSON Lines: one line per section, in this exact order, each line exactly
{"section":"<key>","data":<value>}
and nothing else on that line. Do not wrap lines in code fences. Keys and value shapes:

header        {"slug":string,"name":string,"website":"domain.com","category":string,"oauth":{"supported":boolean,"note":string},"checkedOn":"YYYY-MM-DD","verdict":"2-3 plain sentences: how fast to create, what gates real users, the one thing to watch"}
glance        {"creation":{"rating":1-5,"label":string,"note":string},"approval":{"rating":1-5,"label":string,"note":string},"handsOn":{"value":string,"note":string},"waiting":{"value":string,"note":string},"ownApp":{"managedByComposio":"yes"|"no"|"unknown","headline":string,"note":string}}
prerequisites {"toCreate":[string],"forApproval":[string]}
appTypes      {"items":[{"name","when","whoCanInstall","review","useFor","recommended":boolean}],"notes":[Note]}   mark the type to use for an agent product as recommended
steps         [{"owner":"agent"|"you"|"waiting","title":"imperative, under 9 words","detail":string,"time":string}]   4 to 10 steps in order
scopes        {"intro":string,"rows":[{"useCase":string,"scopes":[string],"impact":string,"level":"none"|"limited"|"review"|"audit"}],"minimalSets":[{"label":string,"scopes":[string],"note":string}],"changingLater":[string]}
approval      {"whenNeeded":string,"cost":string,"renewal":string,"stages":[{"label","duration","detail"}],"submit":[string],"rejections":[string],"note":string}
dataUse       {"rules":[{"title":string,"text":string}],"impact":Note}
blockers      [{"symptom":string,"cause":string,"fix":string,"status"?:Status}]   real error messages in backticks where known
oneWayDoors   [{"title":string,"detail":string,"doThis":string,"status":Status}]   2 to 5 items: defaults and choices that are hard to undo
limits        {"ladder":[{"stage":"Build and test","works":string,"limit":string},{"stage":"First customers",...},{"stage":"Scale",...}],"notes":[Note]}   exactly 3 ladder rows
tokens        {"rows":[{"setting","access","refresh","breaks"}],"note":string}
credentialHandoff {"level":1|2|3,"summary":string,"status":Status}
evidence      {"evidence":[{"claim":string,"status":Status,"basis":"which page says it, or why unsure","url":"the exact page URL that supports it (must also be in sources); omit if unverified"}],"sources":[{"title":string,"url":string}]}

Status is one of "docs" (an official provider page you read says it), "secondary" (third-party page), "conflict" (sources disagree; say which), "unverified" (not found, or from general knowledge). Never use "tested": you did not create an app.
Note is {"title":string,"text":string,"status":Status,"tone":"info"|"warn"|"bad"}.
Ratings: creation 1 = minutes in a form, 5 = days of setup. Approval 1 = no review at all, 2 = self-serve sharing, 3 = capped or admin-gated until review, 4 = formal review taking weeks, 5 = security audit or partner approval at the provider's discretion.
Owners: "agent" = an AI agent can do it from text and APIs (fill forms, choose scopes, draft justifications). "you" = needs the developer's login, legal identity, money, recordings, domain or judgment. "waiting" = provider review.`;

export function researchSystem(): string {
  const core = getSkill("oauth-research");
  return `You are an integrations research agent. You write OAuth app readiness guides for developers who build AI agents on Composio. Their users connect accounts in the vendor's app. Composio offers managed OAuth apps for some toolkits; developers bring their own OAuth app for branding, extra scopes, dedicated rate limits or private instances. The developer needs to know: do I need my own app yet, which choices can't be undone, which app type and scopes to pick, what each scope costs in review, how long approval takes (hands-on time vs waiting), what is capped until review, how tokens behave, what data rules affect agent design, and which steps an agent can do versus a human.

You work autonomously. Nobody answers questions during research. You only read public pages; you never sign in, create anything or contact anyone.

Tools: web_search, web_fetch${renderProvider() !== "off" ? ", render_page (for pages that need JavaScript)" : ""}, load_skill.

Skills you can load with load_skill:
${skillIndex(RESEARCH_SKILLS.filter((s) => s !== "oauth-research"))}

This skill is already loaded:
${core ? core.body : ""}

Writing style: plain English, short sentences, specific numbers with units, no marketing words, no em dashes. Put API names, scopes and error codes in backticks.
Your final message must contain only the stage markers and the JSON Lines described below.
${SCHEMA}`;
}

function calibration(): string {
  const g = libraryGuides().find((x) => x.slug === "notion");
  return g ? `\n\nFor calibration only, this is a finished guide for Notion in the same schema. Match its specificity and tone, not its content:\n${JSON.stringify(g)}` : "";
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, process.env.AGENT_MOCK_FAST === "1" ? 0 : ms));

/** AGENT_MOCK=1 replays a library guide as if researched, to test the whole flow without an API key. */
async function mockResearch(vendor: { name: string; website: string }, emit: (e: AgentEvent) => void) {
  const base = libraryGuides().find((g) => g.slug === "linear")!;
  const today = new Date().toISOString().slice(0, 10);
  const parser = createSectionParser({ slug: slugify(vendor.name), today, emit });
  const script: (() => void)[] = [
    () => parser.push('{"stage":"oauth"}\n'),
    () => emit({ type: "tool", kind: "search", text: `${vendor.name} OAuth app developer docs` }),
    () => parser.push('{"oauth":{"supported":true,"note":"OAuth 2.0 for third-party apps (mock)"}}\n'),
    () => parser.push('{"stage":"docs"}\n'),
    () => emit({ type: "tool", kind: "skill", text: "approval-programs" }),
    () => emit({ type: "tool", kind: "fetch", text: `https://${vendor.website}/developers` }),
    () => parser.push('{"stage":"changelog"}\n'),
    () => emit({ type: "tool", kind: "search", text: `${vendor.name} developer changelog OAuth` }),
    () => parser.push('{"stage":"secondary"}\n'),
    () => parser.push('{"stage":"composio"}\n'),
    () => emit({ type: "tool", kind: "skill", text: "scope-risk" }),
  ];
  for (const step of script) { step(); await wait(300); }
  const g = base as unknown as Record<string, unknown>;
  for (const key of SECTION_ORDER) {
    const data = key === "header"
      ? { name: vendor.name, website: vendor.website, category: "Mock", oauth: { supported: true }, verdict: `MOCK GUIDE for ${vendor.name}. Content copied from the Linear guide to test streaming. No research was done.` }
      : key === "evidence" ? { evidence: (base.evidence || []).map((e) => ({ ...e, status: "unverified" })), sources: base.sources } : g[key];
    parser.push(JSON.stringify({ section: key, data }) + "\n");
    await wait(200);
  }
  parser.end();
}

/** Collects streamed sections into one guide object, so the self-check can run on it. */
function collector(emit: (e: AgentEvent) => void) {
  const g: Record<string, unknown> = {};
  const wrapped = (e: AgentEvent) => {
    if (e.type === "section") {
      if (e.section === "header") Object.assign(g, e.data as object);
      else if (e.section === "evidence") { const d = e.data as { evidence?: unknown; sources?: unknown }; g.evidence = d.evidence; g.sources = d.sources; }
      else g[e.section] = e.data;
    }
    emit(e);
  };
  return { emit: wrapped, guide: g as Partial<Guide> };
}

export async function researchGuide(vendor: { name: string; website: string }, emitRaw: (e: AgentEvent) => void, signal?: AbortSignal) {
  const started = Date.now();
  const { emit, guide } = collector(emitRaw);
  const mock = process.env.AGENT_MOCK === "1";

  if (mock) {
    await mockResearch(vendor, emit);
  } else {
    const today = new Date().toISOString().slice(0, 10);
    const slug = slugify(vendor.name) || slugify(vendor.website);
    const prompt = `Vendor: ${vendor.name} (${vendor.website}). Use slug "${slug}" and checkedOn "${today}". Research it and write the guide.${calibration()}`;
    const parser = createSectionParser({ slug, today, emit });
    const clientTools = [skillTool((name) => { emit({ type: "tool", kind: "skill", text: name }); const st = inferStage("skill", name, vendor.website); if (st) parser.advance(st); }, RESEARCH_SKILLS)];
    if (renderProvider() !== "off") clientTools.push(renderTool);

    parser.advance("oauth");
    let calls = 0;
    const track = (kind: "search" | "fetch" | "render" | "skill", text: string) => {
      calls++;
      // The first call or two is usually the OAuth check itself.
      if (calls <= 1 && parser.stage === "oauth") return;
      const st = inferStage(kind, text, vendor.website || vendor.name);
      if (st) parser.advance(st);
    };
    await runClaude(
      { system: researchSystem(), maxTokens: 20000, tools: webTools(BUDGET.searches, BUDGET.fetches), clientTools, messages: [{ role: "user", content: prompt }] },
      {
        signal,
        onToolUse: (name, input) => {
          if (name === "web_search") { emit({ type: "tool", kind: "search", text: String(input.query ?? "") }); track("search", String(input.query ?? "")); }
          if (name === "web_fetch") { emit({ type: "tool", kind: "fetch", text: String(input.url ?? "") }); track("fetch", String(input.url ?? "")); }
          if (name === "render_page") { emit({ type: "tool", kind: "render", text: String(input.url ?? "") }); track("render", String(input.url ?? "")); }
        },
        onText: (d) => parser.push(d),
      },
    );
    parser.end();
    if (!parser.seen.has("header")) throw new Error(`The agent stopped without writing a guide (it may have hit its ${MAX_ROUNDS}-round limit). Try again, or try the vendor's website.`);
  }

  // Self-check before the developer sees the save prompt.
  emit({ type: "stage", stage: "selfcheck", state: "active" });
  const rules = ruleChecks(guide);
  let checked = rules.guide;
  const notes = [...rules.notes];
  const timeLeft = 230_000 - (Date.now() - started);
  if (!mock && guide.oauth?.supported !== false && timeLeft > 30_000) {
    try {
      const review = await modelReview(checked, signal);
      const applied = applyReview(checked, review);
      checked = applied.guide;
      if (applied.changed) notes.push(`The reviewer lowered the status of ${applied.changed} claim(s).`);
      notes.push(...review.notes);
    } catch (e) {
      notes.push(`The second review didn't finish (${(e as Error).message.slice(0, 80)}); rule checks still ran.`);
    }
  } else if (!mock && guide.oauth?.supported !== false) {
    notes.push("Skipped the second review to stay within the time limit; rule checks still ran.");
  }
  if (JSON.stringify(checked.evidence) !== JSON.stringify(guide.evidence) || JSON.stringify(checked.sources) !== JSON.stringify(guide.sources)) {
    emitRaw({ type: "section", section: "evidence", data: { evidence: checked.evidence, sources: checked.sources } });
  }
  if (JSON.stringify(checked.steps) !== JSON.stringify(guide.steps) && checked.steps) emitRaw({ type: "section", section: "steps", data: checked.steps });
  emit({ type: "selfcheck", counts: countStatuses(checked), notes });
  emit({ type: "stage", stage: "selfcheck", state: "done" });
}
