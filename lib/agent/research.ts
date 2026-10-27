// Steps 2 to 4 of the agent: check OAuth support, research live, stream the guide section by section.
import { runClaude, webTools } from "./claude";
import { SECTION_ORDER, SECTION_TITLES } from "../schema";
import { libraryGuides, slugify } from "../library";

export type AgentEvent =
  | { type: "status"; text: string }
  | { type: "section"; section: string; data: unknown }
  | { type: "error"; message: string }
  | { type: "done" };

const SCHEMA = `
Output protocol. After researching, write the guide as JSON Lines: one line per section, in this exact order, each line exactly
{"section":"<key>","data":<value>}
and nothing else on that line. Do not wrap lines in code fences. Keys and value shapes:

header        {"slug":string,"name":string,"website":"domain.com","category":string,"oauth":{"supported":boolean,"note":string},"checkedOn":"YYYY-MM-DD","verdict":"2-3 plain sentences: how fast to create, what gates real users, the one thing to watch"}
glance        {"creation":{"rating":1-5,"label":string,"note":string},"approval":{"rating":1-5,"label":string,"note":string},"handsOn":{"value":string,"note":string},"waiting":{"value":string,"note":string},"ownApp":{"managedByComposio":"yes"|"no"|"unknown","headline":string,"note":string}}
oneWayDoors   [{"title":string,"detail":string,"doThis":string,"status":Status}]   2 to 5 items: defaults and choices that are hard to undo
appTypes      {"items":[{"name","when","whoCanInstall","review","useFor","recommended":boolean}],"notes":[Note]}   mark the type to use for an agent product as recommended
scopes        {"intro":string,"rows":[{"useCase":string,"scopes":[string],"impact":string,"level":"none"|"limited"|"review"|"audit"}],"minimalSets":[{"label":string,"scopes":[string],"note":string}],"changingLater":[string]}
prerequisites {"toCreate":[string],"forApproval":[string]}
steps         [{"owner":"agent"|"you"|"waiting","title":"imperative, under 9 words","detail":string,"time":string}]   4 to 10 steps in order
approval      {"whenNeeded":string,"cost":string,"renewal":string,"stages":[{"label","duration","detail"}],"submit":[string],"rejections":[string],"note":string}
limits        {"ladder":[{"stage":"Build and test","works":string,"limit":string},{"stage":"First customers",...},{"stage":"Scale",...}],"notes":[Note]}   exactly 3 ladder rows
tokens        {"rows":[{"setting","access","refresh","breaks"}],"note":string}
dataUse       {"rules":[{"title":string,"text":string}],"impact":Note}
credentialHandoff {"level":1|2|3,"summary":string,"status":Status}
blockers      [{"symptom":string,"cause":string,"fix":string,"status"?:Status}]   real error messages in backticks where known
evidence      {"evidence":[{"claim":string,"status":Status,"basis":"which page says it, or why unsure"}],"sources":[{"title":string,"url":string}]}

Status is one of "docs" (an official provider page you read says it), "secondary" (third-party page), "conflict" (sources disagree; say which), "unverified" (not found, or from general knowledge). Never use "tested": you did not create an app.
Note is {"title":string,"text":string,"status":Status,"tone":"info"|"warn"|"bad"}.
Ratings: creation 1 = minutes in a form, 5 = days of setup. Approval 1 = no review at all, 2 = self-serve sharing, 3 = capped or admin-gated until review, 4 = formal review taking weeks, 5 = security audit or partner approval at the provider's discretion.
Credential handoff: 1 = an API can create the app and return credentials, 2 = console only but the secret can be copied, 3 = a human step is required to reveal the secret.
Owners: "agent" = an AI agent can do it from text and APIs (fill forms, choose scopes, draft justifications). "you" = needs the developer's login, legal identity, money, recordings, domain or judgment. "waiting" = provider review.

If the vendor does not offer OAuth for third-party apps, emit header with oauth.supported=false and oauth.note explaining what it uses instead (API keys, basic auth, service accounts) and what that means for a Composio integration, then emit evidence, and stop.`;

const SYSTEM = `You are an integrations researcher writing an OAuth app readiness guide for developers who build AI agents on Composio. Their users will connect accounts in the vendor's app. Composio offers managed OAuth apps for some toolkits; developers bring their own OAuth app for branding, extra scopes, dedicated rate limits or private instances. The developer needs to know: do I need my own app yet, which choices can't be undone, which app type and scopes to pick, what each scope costs in review, how long approval takes (hands-on time vs waiting), what is capped until review, how tokens behave, what data rules affect agent design, and which steps an agent can do versus a human.

Research protocol, in this order:
1. Confirm the vendor supports OAuth 2.0 for third-party apps. If not, follow the no-OAuth rule.
2. Official developer docs: creating an OAuth app, app types or distribution modes, scopes and how they are classified, any review, verification or marketplace process, limits for unreviewed apps (install caps, user caps, rate limits), token lifetimes and refresh behaviour, and API terms on data use and AI training.
3. The vendor's developer changelog for the last 18 months: new restrictions, deprecations, rate-limit changes.
4. Secondary sources (integration platforms' setup guides, developer forums) for real review times and common errors.
5. Composio docs (docs.composio.dev) for whether this toolkit has a Composio-managed OAuth app. If you cannot confirm, use "unknown".
Prefer official docs when sources disagree, and record the disagreement as a conflict. Do not invent numbers: if a timeline is not published, say "Not published".

Writing style: plain English, short sentences, specific numbers with units, no marketing words, no em dashes. Put API names, scopes and error codes in backticks.
Do your research first. Your final message must contain only the JSON Lines described below.
${SCHEMA}`;

function calibration(): string {
  const g = libraryGuides().find((x) => x.slug === "notion");
  return g ? `\n\nFor calibration only, this is a finished guide for Notion in the same schema. Match its specificity and tone, not its content:\n${JSON.stringify(g)}` : "";
}

/** AGENT_MOCK=1 replays a library guide as if researched, to test the streaming UI without an API key. */
async function mockResearch(vendor: { name: string; website: string }, emit: (e: AgentEvent) => void) {
  const base = libraryGuides().find((g) => g.slug === "linear")!;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (const s of [`Searching: ${vendor.name} OAuth app developer docs`, `Reading: https://${vendor.website}/developers`, `Searching: ${vendor.name} app review changelog`]) { emit({ type: "status", text: s }); await wait(400); }
  const g = base as unknown as Record<string, unknown>;
  for (const key of SECTION_ORDER) {
    const data = key === "header"
      ? { slug: slugify(vendor.name), name: vendor.name, website: vendor.website, category: "Mock", oauth: { supported: true }, checkedOn: new Date().toISOString().slice(0, 10), verdict: `MOCK GUIDE for ${vendor.name}. Content copied from the Linear guide to test streaming.`, evidenceLevel: "generated" }
      : key === "evidence" ? { evidence: (base.evidence || []).map((e) => ({ ...e, status: "unverified" })), sources: base.sources } : g[key];
    emit({ type: "section", section: key, data });
    await wait(250);
  }
}

export async function researchGuide(vendor: { name: string; website: string }, emit: (e: AgentEvent) => void, signal?: AbortSignal) {
  if (process.env.AGENT_MOCK === "1") return mockResearch(vendor, emit);
  const today = new Date().toISOString().slice(0, 10);
  const slug = slugify(vendor.name) || slugify(vendor.website);
  const prompt = `Vendor: ${vendor.name} (${vendor.website}). Use slug "${slug}" and checkedOn "${today}". Research it and write the guide.${calibration()}`;

  emit({ type: "status", text: `Checking whether ${vendor.name} supports OAuth…` });
  let pending = "";
  const seen = new Set<string>();
  const handleLine = (line: string) => {
    const t = line.trim();
    if (!t.startsWith("{")) return;
    try {
      const o = JSON.parse(t) as { section?: string; data?: unknown };
      if (!o.section || !(SECTION_ORDER as readonly string[]).includes(o.section) || seen.has(o.section)) return;
      seen.add(o.section);
      if (o.section === "header") Object.assign(o.data as object, { slug, evidenceLevel: "generated", checkedOn: today });
      emit({ type: "section", section: o.section, data: o.data });
      emit({ type: "status", text: `Wrote: ${SECTION_TITLES[o.section]?.title ?? "verdict"}` });
    } catch { /* partial or narrative line */ }
  };

  await runClaude(
    { system: SYSTEM, maxTokens: 20000, tools: webTools(10, 8), messages: [{ role: "user", content: prompt }] },
    {
      signal,
      onToolUse: (name, input) => {
        if (name === "web_search") emit({ type: "status", text: `Searching: ${String(input.query ?? "")}` });
        if (name === "web_fetch") emit({ type: "status", text: `Reading: ${String(input.url ?? "")}` });
      },
      onText: (delta) => {
        pending += delta;
        const lines = pending.split("\n");
        pending = lines.pop() || "";
        lines.forEach(handleLine);
      },
    },
  );
  handleLine(pending);
  if (!seen.has("header")) throw new Error("The agent did not produce a guide. Try again, or try the vendor's website.");
}
