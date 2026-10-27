// Turns the research agent's streamed text into events.
// The model writes two kinds of JSON lines:
//   {"stage":"docs"}                        progress markers while researching
//   {"section":"glance","data":{...}}       one finished guide section
// Everything else (narration, partial lines, code fences) is ignored.
import { SECTION_ORDER, SECTION_TITLES } from "../schema";

export const STAGES = ["oauth", "docs", "changelog", "secondary", "composio", "write", "selfcheck"] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABEL: Record<Stage, { title: string; note: string }> = {
  oauth: { title: "Check OAuth support", note: "Does the vendor offer OAuth for third-party apps?" },
  docs: { title: "Read official docs", note: "App creation, scopes, review, limits, tokens" },
  changelog: { title: "Changelog, last 18 months", note: "New restrictions and deprecations" },
  secondary: { title: "Other sources", note: "Real review times and common errors" },
  composio: { title: "Composio docs", note: "Is there a managed app for this toolkit?" },
  write: { title: "Write the guide", note: "Section by section, with sources" },
  selfcheck: { title: "Self-check", note: "Each claim checked against its source" },
};

export type AgentEvent =
  | { type: "status"; text: string }
  | { type: "stage"; stage: Stage; state: "active" | "done" }
  | { type: "tool"; kind: "search" | "fetch" | "render" | "skill"; text: string }
  | { type: "section"; section: string; data: unknown }
  | { type: "selfcheck"; counts: Record<string, number>; notes: string[] }
  | { type: "error"; message: string }
  | { type: "done" };

export function createSectionParser(opts: { slug: string; today: string; emit: (e: AgentEvent) => void }) {
  const seen = new Set<string>();
  let pending = "";
  let active: Stage | null = null;

  const setStage = (s: Stage) => {
    if (active === s) return;
    if (active) opts.emit({ type: "stage", stage: active, state: "done" });
    active = s;
    opts.emit({ type: "stage", stage: s, state: "active" });
  };

  const line = (raw: string) => {
    const t = raw.trim().replace(/^```(?:json|jsonl)?/, "").replace(/```$/, "").trim();
    if (!t.startsWith("{") || !t.endsWith("}")) return;
    let o: { section?: string; data?: unknown; stage?: string };
    try { o = JSON.parse(t); } catch { return; }
    if (o.stage && (STAGES as readonly string[]).includes(o.stage) && !o.section) { setStage(o.stage as Stage); return; }
    if (!o.section || !(SECTION_ORDER as readonly string[]).includes(o.section) || seen.has(o.section)) return;
    if (o.data === undefined || o.data === null) return;
    if (o.section === "header") {
      if (typeof o.data !== "object") return;
      Object.assign(o.data as object, { slug: opts.slug, evidenceLevel: "generated", checkedOn: opts.today });
    }
    setStage("write");
    seen.add(o.section);
    opts.emit({ type: "section", section: o.section, data: o.data });
    opts.emit({ type: "status", text: `Wrote: ${SECTION_TITLES[o.section]?.title ?? "verdict and header"}` });
  };

  return {
    push(delta: string) {
      pending += delta;
      const lines = pending.split("\n");
      pending = lines.pop() || "";
      lines.forEach(line);
    },
    end() {
      if (pending) line(pending);
      pending = "";
      if (active) { opts.emit({ type: "stage", stage: active, state: "done" }); active = null; }
    },
    seen,
  };
}
