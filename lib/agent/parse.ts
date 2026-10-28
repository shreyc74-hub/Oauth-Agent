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
  | { type: "oauth"; supported: boolean; note: string }
  | { type: "error"; message: string }
  | { type: "done" };

/**
 * Works out which research stage a tool call belongs to, so progress moves even when the model
 * forgets to write stage markers. Returns null when the call doesn't say anything new.
 */
export function inferStage(kind: "search" | "fetch" | "render" | "skill", text: string, vendorDomain: string): Stage | null {
  const t = String(text || "").toLowerCase();
  const base = vendorDomain.toLowerCase().replace(/^www\./, "").split(".")[0] || "\u0000";
  if (kind === "skill") {
    if (t === "no-oauth") return "oauth";
    if (["approval-programs", "scope-risk", "credential-handoff"].includes(t)) return "docs";
    return null;
  }
  if (/composio/.test(t)) return "composio";
  if (/changelog|release[- ]?notes|what'?s[- ]new|deprecat|sunset|announc|\/blog\/|platform[- ]updates/.test(t)) return "changelog";
  const host = kind === "search" ? "" : (() => { try { return new URL(/^https?:/.test(t) ? t : `https://${t}`).hostname; } catch { return ""; } })();
  const thirdParty = /zapier|n8n|nango|pipedream|merge\.dev|make\.com|paragon|workato|tray\.io|stackoverflow|stackexchange|reddit|medium\.com|dev\.to|github\.com|community\.|forum|discourse/;
  if (thirdParty.test(host || t)) return "secondary";
  if (kind === "search" && /review (time|took|took)|how long|experience|error|issue|rejected|stuck/.test(t)) return "secondary";
  if (host) return host.includes(base) || /developer|docs?\.|api\./.test(host) ? "docs" : "secondary";
  if (/oauth|scope|rate limit|token|app review|marketplace|publish|verification|developer|api|install/.test(t)) return "docs";
  return null;
}

export function createSectionParser(opts: { slug: string; today: string; emit: (e: AgentEvent) => void }) {
  const seen = new Set<string>();
  let pending = "";
  let active: Stage | null = null;
  let oauthSent = false;

  // Stages only move forward, so the progress list never jumps back.
  const setStage = (s: Stage) => {
    if (active === s) return;
    if (active && STAGES.indexOf(s) < STAGES.indexOf(active)) return;
    if (active) opts.emit({ type: "stage", stage: active, state: "done" });
    active = s;
    opts.emit({ type: "stage", stage: s, state: "active" });
  };
  const oauth = (supported: boolean, note: string) => {
    if (oauthSent) return;
    oauthSent = true;
    opts.emit({ type: "oauth", supported, note: String(note || (supported ? "OAuth available" : "No OAuth for third-party apps")).slice(0, 160) });
  };

  const line = (raw: string) => {
    const t = raw.trim().replace(/^```(?:json|jsonl)?/, "").replace(/```$/, "").trim();
    if (!t.startsWith("{") || !t.endsWith("}")) return;
    let o: { section?: string; data?: unknown; stage?: string; oauth?: { supported?: boolean; note?: string } };
    try { o = JSON.parse(t); } catch { return; }
    if (o.oauth && typeof o.oauth.supported === "boolean" && !o.section) {
      oauth(o.oauth.supported, o.oauth.note || "");
      if (o.oauth.supported) setStage("docs");
      return;
    }
    if (o.stage && (STAGES as readonly string[]).includes(o.stage) && !o.section) { setStage(o.stage as Stage); return; }
    if (!o.section || !(SECTION_ORDER as readonly string[]).includes(o.section) || seen.has(o.section)) return;
    if (o.data === undefined || o.data === null) return;
    if (o.section === "header") {
      if (typeof o.data !== "object") return;
      Object.assign(o.data as object, { slug: opts.slug, evidenceLevel: "generated", checkedOn: opts.today });
      const h = o.data as { oauth?: { supported?: boolean; note?: string } };
      if (h.oauth && typeof h.oauth.supported === "boolean") oauth(h.oauth.supported, h.oauth.note || "");
    }
    setStage("write");
    seen.add(o.section);
    opts.emit({ type: "section", section: o.section, data: o.data });
    opts.emit({ type: "status", text: `Wrote: ${SECTION_TITLES[o.section]?.title ?? "verdict and header"}` });
  };

  return {
    /** Moves progress forward from outside (tool activity). Ignored if it would go backwards. */
    advance(s: Stage) { if (!seen.size || s === "write" || s === "selfcheck") setStage(s); },
    get stage() { return active; },
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
