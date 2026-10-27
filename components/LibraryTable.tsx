"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import type { GuideSummary } from "@/lib/store";
import { Meter } from "./GuideView";

const EV = { tested: "Tested", docs: "Docs-checked", generated: "Generated" } as const;
const tone = (n: number) => (n <= 2 ? "g" : n === 3 ? "a" : "r") as "g" | "a" | "r";

export type Filter = "all" | "noreview" | "week" | "tested";

/** Filter rules, exported for tests. Approval ratings: 1 none, 2 self-serve, 3 capped until review, 4 weeks of review, 5 audit. */
export function applyFilter(rows: GuideSummary[], f: Filter, category: string): GuideSummary[] {
  return rows.filter((r) => {
    if (category !== "all" && r.category !== category) return false;
    if (f === "noreview") return r.oauthSupported && r.approval > 0 && r.approval <= 2;
    if (f === "week") return r.oauthSupported && r.approval > 0 && r.approval <= 3;
    if (f === "tested") return r.evidenceLevel === "tested";
    return true;
  });
}

export default function LibraryTable({ rows, title, note, filters = true, empty }: { rows: GuideSummary[]; title: string; note?: string; filters?: boolean; empty?: string }) {
  const [f, setF] = useState<Filter>("all");
  const [cat, setCat] = useState("all");
  const cats = useMemo(() => [...new Set(rows.map((r) => r.category).filter(Boolean))].sort(), [rows]);
  const shown = applyFilter(rows, f, cat);
  const seg = (id: Filter, label: string) => <button type="button" className="seg" aria-pressed={f === id} onClick={() => setF(id)}>{label}</button>;

  return (
    <section className="block">
      <div className="libhead">
        <h2>{title}</h2>
        {filters && rows.length > 0 ? (
          <div className="filters" role="group" aria-label="Filter the library">
            {seg("all", `All ${rows.length}`)}
            {seg("noreview", "No review needed")}
            {seg("week", "Live in under a week")}
            {seg("tested", "Tested only")}
            <label className="sr" htmlFor={`cat-${title}`}>Category</label>
            <select id={`cat-${title}`} className="seg" value={cat} onChange={(e) => setCat(e.target.value)}>
              <option value="all">All categories</option>
              {cats.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        ) : note ? <span className="small">{note}</span> : null}
      </div>
      {rows.length === 0 ? <p className="empty">{empty}</p> : (
        <div className="libtable">
          <div className="grid">
            <div className="lrow h" aria-hidden="true"><span>App</span><span>Create</span><span>Approve</span><span>Waiting</span><span>The trap to know first</span><span>Evidence</span></div>
            {shown.map((r) => (
              <Link key={r.slug} href={`/guides/${r.slug}`} className="lrow">
                <span><span className="nm">{r.name}</span><span className="dm">{r.website}</span></span>
                <span>{r.oauthSupported ? <Meter n={r.creation} tone={tone(r.creation)} /> : <span className="w">No OAuth</span>}</span>
                <span>{r.oauthSupported ? <Meter n={r.approval} tone={tone(r.approval)} /> : <span className="w">n/a</span>}</span>
                <span className="w">{r.waiting || "n/a"}</span>
                <span>{r.trap}</span>
                <span><span className={`badge ev-${r.evidenceLevel}`}>{EV[r.evidenceLevel]}</span></span>
              </Link>
            ))}
            {shown.length === 0 && <p className="empty">No guides match these filters.</p>}
          </div>
        </div>
      )}
    </section>
  );
}
