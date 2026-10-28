// The chat agent. Same agent loop as research, different goal: answer a developer's questions
// from the guides, compare apps, identify unknown apps and offer research, and propose
// corrections. It reads freely; every write (a correction to a guide) is proposed and waits
// for the developer's approval on screen. Research is started by the developer, never by the agent.
import { runClaude, webTools, type ClientTool } from "./claude";
import { getSkill, skillIndex, skillTool } from "./skills";
import { identify, cleanDomain } from "./resolve";
import { listGuides, getGuide, type GuideSummary } from "../store";
import { matchLibrary, libraryGuides, slugify } from "../library";
import { SECTION_ORDER, SECTION_TITLES, type Guide } from "../schema";

export const CHAT_SKILLS = ["answering-questions", "vendor-identification", "scope-risk", "approval-programs", "credential-handoff"];

export type ChatAction =
  | { kind: "research"; name: string; website: string }
  | { kind: "approve"; id: string; tool: "save_correction"; title: string; detail: string; payload: Record<string, string> };

export type ChatEvent =
  | { type: "text"; delta: string }
  | { type: "tool"; kind: "read" | "search" | "identify" | "skill" | "web"; text: string }
  | { type: "action"; action: ChatAction }
  | { type: "error"; message: string }
  | { type: "done" };

export type ChatMessage = { role: "user" | "assistant"; content: string };

const brief = (g: GuideSummary) => `- ${g.slug}: ${g.name} (${g.website}). Approval ${g.approval}/5, waiting ${g.waiting}. ${g.evidenceLevel}. Trap: ${g.trap}`;

/** Returns a guide, or only some sections of it, as compact JSON for the model. */
export function guideForModel(g: Guide, sections?: string[]): string {
  if (!sections || !sections.length) return JSON.stringify(g);
  const keep: Record<string, unknown> = { slug: g.slug, name: g.name, verdict: g.verdict, evidenceLevel: g.evidenceLevel, checkedOn: g.checkedOn };
  for (const s of sections) if (s in g) keep[s] = (g as unknown as Record<string, unknown>)[s];
  if (sections.length) { keep.evidence = g.evidence; }
  return JSON.stringify(keep);
}

export type Draft = { name?: string; website?: string; running?: boolean; guide: Record<string, unknown> };

/** Keeps only known guide sections from a draft the browser sends, capped in size. Returns null if unusable. */
export function cleanDraft(raw: unknown): Draft | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const g = (r.guide && typeof r.guide === "object" ? r.guide : {}) as Record<string, unknown>;
  const keep: Record<string, unknown> = {};
  for (const k of [...SECTION_ORDER, "name", "website", "category", "oauth", "verdict", "sources"]) if (k in g && k !== "header") keep[k] = g[k];
  const json = JSON.stringify(keep);
  if (json.length > 150_000) return null;
  return { name: String(r.name || g.name || "").slice(0, 120), website: String(r.website || g.website || "").slice(0, 200), running: Boolean(r.running), guide: keep };
}

export function chatSystem(index: GuideSummary[], current: Guide | null, draft: Draft | null = null): string {
  const sk = getSkill("answering-questions");
  const sectionList = Object.entries(SECTION_TITLES).filter(([, v]) => v.num).map(([k, v]) => `§${v.num} ${v.title} (${k})`).join(", ");
  return `You are the OAuth readiness agent for developers who build AI agents on Composio. You answer questions about creating provider OAuth apps, getting them approved, and the limits before approval.

You work with tools. Read guides before answering about them. You can't sign in anywhere, create apps, or change anything yourself.

Guides in the library (slug: summary):
${index.map(brief).join("\n")}

Guide sections shown to the developer (cite only these): ${sectionList}. The guide data also holds one-way decisions, limits before approval, tokens and credential handoff; use them in answers, and cite the closest shown section (limits and one-way decisions under §06 or §01, tokens under §04).

${current ? `The developer is reading the ${current.name} guide (slug "${current.slug}"). Its full content:\n${JSON.stringify(current)}\n`
  : draft ? `The developer is watching the research agent write a NEW guide for ${draft.name} (${draft.website}). ${draft.running ? "Research is still running: sections not shown below are not written yet." : "Research has finished; the guide is not saved yet and not reviewed by a person."} Answer from this draft first, and say it is an unsaved draft whose statuses may still change. If a section isn't written yet, say so and answer from the library or a quick web search, labelled. Cite draft sections as [§NN] without a slug. Draft so far:\n${JSON.stringify(draft.guide)}\n`
  : "The developer is on the library page, not reading a specific guide."}

Skills you can load with load_skill:
${skillIndex(CHAT_SKILLS.filter((s) => s !== "answering-questions"))}

This skill is already loaded:
${sk ? sk.body : ""}

Permission rules: reading, searching and identifying need no permission. Anything that writes needs the developer's approval: call save_correction to propose it; it only happens if they click Approve. Research costs time and money, so you offer it with propose_research and the developer starts it.`;
}

export function chatTools(emit: (e: ChatEvent) => void): ClientTool[] {
  return [
    {
      name: "search_library",
      description: "Lists library guides that match a name, domain or category. Empty query lists all.",
      input_schema: { type: "object", properties: { query: { type: "string" } } },
      run: async (input) => {
        const q = String(input.query || "").toLowerCase().trim();
        emit({ type: "tool", kind: "search", text: q ? `Searching the library for "${q}"` : "Listing the library" });
        const all = await listGuides();
        const hit = q ? all.filter((g) => [g.slug, g.name, g.website, g.category].some((v) => String(v).toLowerCase().includes(q))) : all;
        return hit.length ? hit.map(brief).join("\n") : `No guide matches "${q}".`;
      },
    },
    {
      name: "read_guide",
      description: "Reads one guide by slug. Optionally only some sections (keys like glance, limits, approval, scopes, steps, tokens, evidence).",
      input_schema: { type: "object", properties: { slug: { type: "string" }, sections: { type: "array", items: { type: "string" } } }, required: ["slug"] },
      run: async (input) => {
        const slug = slugify(String(input.slug || ""));
        const g = (await getGuide(slug)) || matchLibrary(String(input.slug || ""), libraryGuides());
        emit({ type: "tool", kind: "read", text: `Reading the ${g?.name ?? slug} guide` });
        if (!g) return `No guide with slug "${slug}". Use search_library, or propose_research for a new app.`;
        const sections = Array.isArray(input.sections) ? (input.sections as string[]).filter((s) => (SECTION_ORDER as readonly string[]).includes(s) || s === "steps") : undefined;
        return guideForModel(g, sections);
      },
    },
    {
      name: "identify_vendor",
      description: "Works out which software vendor a name or link refers to. Returns unique, ambiguous (ask the developer to confirm) or unknown.",
      input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      run: async (input) => {
        const q = String(input.query || "").slice(0, 300);
        emit({ type: "tool", kind: "identify", text: `Identifying "${q}"` });
        const lib = matchLibrary(q, libraryGuides());
        if (lib) return JSON.stringify({ status: "unique", vendor: { name: lib.name, website: lib.website }, inLibrary: lib.slug });
        if (process.env.AGENT_MOCK === "1") return JSON.stringify({ status: "unique", vendor: { name: q, website: q.includes(".") ? q : `${q}.com` }, mock: true });
        return JSON.stringify(await identify(q));
      },
    },
    {
      name: "propose_research",
      description: "Shows the developer a button to research a new app and write its guide (2 to 4 minutes). Use for a confirmed vendor with no guide. You don't start it; they do.",
      input_schema: { type: "object", properties: { name: { type: "string" }, website: { type: "string" } }, required: ["name", "website"] },
      run: async (input) => {
        const name = String(input.name || "").slice(0, 120).trim();
        const website = cleanDomain(String(input.website || ""));
        if (!name) return "A vendor name is required.";
        emit({ type: "action", action: { kind: "research", name, website } });
        return `Shown a "Research ${name}" button. The developer decides whether to start it. Tell them what research covers and how long it takes.`;
      },
    },
    {
      name: "save_correction",
      description: "Proposes saving a correction to a guide's review queue, for example when the developer says a claim is wrong or out of date. It is saved only if the developer approves it on screen.",
      input_schema: { type: "object", properties: { slug: { type: "string" }, section: { type: "string" }, claim: { type: "string", description: "What the guide says now" }, correction: { type: "string", description: "What it should say" }, source: { type: "string", description: "Link or reason given by the developer" } }, required: ["slug", "claim", "correction"] },
      run: async (input) => {
        const payload = {
          slug: slugify(String(input.slug || "")),
          section: String(input.section || "").slice(0, 40),
          claim: String(input.claim || "").slice(0, 600),
          correction: String(input.correction || "").slice(0, 600),
          source: String(input.source || "").slice(0, 300),
        };
        if (!payload.slug || !payload.claim || !payload.correction) return "slug, claim and correction are required.";
        const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        emit({ type: "action", action: { kind: "approve", id, tool: "save_correction", title: `Save a correction to the ${payload.slug} guide?`, detail: `Now: ${payload.claim}\nShould say: ${payload.correction}${payload.source ? `\nSource: ${payload.source}` : ""}`, payload } });
        return "Shown to the developer for approval. Nothing is saved unless they click Approve. Tell them it's waiting for their approval.";
      },
    },
    skillTool((name) => emit({ type: "tool", kind: "skill", text: `Loaded skill: ${name}` }), CHAT_SKILLS),
  ];
}

/** Mock replies for AGENT_MOCK=1: exercise every tool and action without an API key. */
async function mockChat(messages: ChatMessage[], current: Guide | null, emit: (e: ChatEvent) => void) {
  const q = (messages[messages.length - 1]?.content || "").toLowerCase();
  const tools = chatTools(emit);
  const run = (n: string, i: Record<string, unknown>) => tools.find((t) => t.name === n)!.run(i);
  const other = libraryGuides().find((g) => q.includes(g.slug) && g.slug !== current?.slug);
  if (/wrong|incorrect|out of date|outdated/.test(q) && current) {
    await run("save_correction", { slug: current.slug, section: "limits", claim: current.limits?.notes?.[0]?.title || current.verdict, correction: "As described by the developer", source: "Developer report" });
    emit({ type: "text", delta: "MOCK: I've proposed a correction. It's waiting for your approval below." });
    return;
  }
  if (other || current) {
    const g = other ?? current!;
    await run("read_guide", { slug: g.slug, sections: ["glance", "limits"] });
    emit({ type: "text", delta: `MOCK answer from the ${g.name} guide: ${g.glance?.waiting?.value ?? ""} waiting on the provider. [§01 ${g.slug}] [§08 ${g.slug}]` });
    return;
  }
  const word = q.replace(/[^a-z0-9.\s]/g, " ").split(/\s+/).filter((w) => w.length > 3).pop() || "example";
  await run("identify_vendor", { query: word });
  await run("propose_research", { name: word.charAt(0).toUpperCase() + word.slice(1), website: word.includes(".") ? word : `${word}.com` });
  emit({ type: "text", delta: `MOCK: There's no guide for ${word} yet. You can research it with the button below.` });
}

export async function runChat(input: { messages: ChatMessage[]; slug?: string; draft?: Draft | null }, emit: (e: ChatEvent) => void, signal?: AbortSignal) {
  const current = input.slug ? await getGuide(input.slug) : null;
  const draft = current ? null : input.draft ?? null;
  if (process.env.AGENT_MOCK === "1") {
    if (draft) { emit({ type: "text", delta: `MOCK: From the unsaved ${draft.name} draft: ${String((draft.guide.verdict as string) || "the verdict isn't written yet.")} [§01]` }); return; }
    return mockChat(input.messages, current, emit);
  }
  const index = await listGuides();
  await runClaude(
    { system: chatSystem(index, current, draft), maxTokens: 2500, tools: webTools(2, 2), clientTools: chatTools(emit), messages: input.messages },
    {
      signal,
      onText: (d) => emit({ type: "text", delta: d }),
      onToolUse: (name, i) => {
        if (name === "web_search") emit({ type: "tool", kind: "web", text: `Searching the web: ${String(i.query ?? "")}` });
        if (name === "web_fetch") emit({ type: "tool", kind: "web", text: `Reading ${String(i.url ?? "")}` });
      },
    },
  );
}

/** Validates and trims the conversation the browser sends. Returns null if unusable. */
export function cleanMessages(raw: unknown): ChatMessage[] | null {
  if (!Array.isArray(raw)) return null;
  const msgs = raw
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m) => ({ role: m.role as ChatMessage["role"], content: String(m.content).slice(0, 4000) }))
    .slice(-12);
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") return null;
  // The API needs alternating roles; merge any repeats.
  const merged: ChatMessage[] = [];
  for (const m of msgs) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += "\n\n" + m.content; else merged.push({ ...m });
  }
  return merged;
}

