// Self-check: runs after the research agent writes a guide and before the developer sees the
// save prompt. Two layers:
//   1. Rule checks in code (always run, testable): no "tested" claims, sources must be real URLs,
//      "official docs" needs at least one source, owners and ladder shape are valid.
//   2. A second model pass (when time allows) that re-reads the guide against its own sources
//      and downgrades claims the evidence does not support.
import type { Guide, Status } from "../schema";
import { runClaude, extractJson, RESOLVE_MODEL } from "./claude";

export const STATUSES: Status[] = ["tested", "docs", "secondary", "conflict", "unverified"];

export function countStatuses(g: Partial<Guide>): Record<string, number> {
  const c: Record<string, number> = { docs: 0, secondary: 0, conflict: 0, unverified: 0 };
  for (const e of g.evidence || []) c[e.status] = (c[e.status] || 0) + 1;
  return c;
}

const isUrl = (u: unknown) => { try { return /^https?:$/.test(new URL(String(u)).protocol); } catch { return false; } };

export function ruleChecks(input: Partial<Guide>): { guide: Partial<Guide>; notes: string[] } {
  const g: Partial<Guide> = JSON.parse(JSON.stringify(input));
  const notes: string[] = [];

  const before = (g.sources || []).length;
  g.sources = (g.sources || []).filter((s) => s && s.title && isUrl(s.url));
  if (g.sources.length < before) notes.push(`Removed ${before - g.sources.length} source(s) without a valid link.`);

  let downgraded = 0;
  g.evidence = (g.evidence || []).filter((e) => e && e.claim).map((e) => {
    let status: Status = STATUSES.includes(e.status) ? e.status : "unverified";
    if (status === "tested") { status = "unverified"; downgraded++; }
    if (status === "docs" && (!g.sources!.length || !String(e.basis || "").trim())) { status = "unverified"; downgraded++; }
    const url = e.url && isUrl(e.url) ? e.url : undefined;
    return { ...e, status, basis: e.basis || "No basis given", url };
  });
  if (downgraded) notes.push(`Marked ${downgraded} claim(s) "not verified" because they had no source behind them.`);

  if (g.oauth?.supported !== false) {
    if (g.steps) {
      let fixed = 0;
      g.steps = g.steps.map((s) => (["agent", "you", "waiting"].includes(s.owner) ? s : (fixed++, { ...s, owner: "you" as const })));
      if (fixed) notes.push(`Set ${fixed} step(s) with an unknown owner to "You".`);
    }
    if (g.limits && g.limits.ladder?.length !== 3) notes.push("The limits ladder should have exactly 3 stages; check section 08.");
    if (g.glance && g.glance.approval?.rating >= 4 && !(g.approval?.stages || []).length) notes.push("Approval is rated hard but no review stages are listed.");
    const numbers = JSON.stringify([g.glance, g.limits, g.approval]).match(/\d+/g)?.length ?? 0;
    if (numbers > 0 && (g.evidence || []).length < 3) notes.push("The guide states numbers but has fewer than 3 evidence lines.");
  }
  return { guide: g, notes };
}

const REVIEW = `You are a strict reviewer of an OAuth app readiness guide written by another agent.
Check each evidence line against the guide's own sources list and the content of the guide.
Return only JSON: {"evidence":[{"claim":string,"status":"docs"|"secondary"|"conflict"|"unverified","basis":string}],"notes":[string]}
Rules:
- Keep the same claims in the same order. You may only lower a status, never raise it, except to mark "conflict" when the guide states two different values for the same thing.
- "docs" needs a source on the vendor's official domain or developer site. Otherwise "secondary" (third-party page in sources) or "unverified".
- Add a note for each contradiction between sections (for example a cap of 100 in one place and 250 in another), each number that has no evidence line, and anything that looks invented. Max 6 notes, one sentence each. No em dashes.`;

export async function modelReview(g: Partial<Guide>, signal?: AbortSignal): Promise<{ evidence?: Guide["evidence"]; notes: string[] }> {
  const text = await runClaude({ model: RESOLVE_MODEL, system: REVIEW, maxTokens: 6000, messages: [{ role: "user", content: JSON.stringify(g) }] }, { signal });
  const r = extractJson<{ evidence?: Guide["evidence"]; notes?: string[] }>(text);
  return { evidence: r.evidence, notes: (r.notes || []).filter((n) => typeof n === "string").slice(0, 6) };
}

const rank: Record<string, number> = { docs: 3, secondary: 2, conflict: 1, unverified: 0, tested: 4 };

/** Applies a model review safely: same length, same claims, statuses only go down (or to conflict). */
export function applyReview(g: Partial<Guide>, review: { evidence?: Guide["evidence"] }): { guide: Partial<Guide>; changed: number } {
  const cur = g.evidence || [];
  const next = review.evidence;
  if (!Array.isArray(next) || next.length !== cur.length) return { guide: g, changed: 0 };
  let changed = 0;
  const evidence = cur.map((e, i) => {
    const r = next[i];
    if (!r || !STATUSES.includes(r.status) || r.status === e.status) return e;
    const lower = rank[r.status] < rank[e.status];
    if (!lower && r.status !== "conflict") return e;
    changed++;
    return { ...e, status: r.status, basis: r.basis || e.basis };
  });
  return { guide: { ...g, evidence }, changed };
}
