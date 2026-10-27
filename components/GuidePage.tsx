"use client";
import { useState } from "react";
import Link from "next/link";
import type { Guide } from "@/lib/schema";
import { toMarkdown } from "@/lib/markdown";
import GuideView from "./GuideView";

export function downloadText(filename: string, text: string, type = "text/markdown") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function Toolbar({ g, extra }: { g: Guide; extra?: React.ReactNode }) {
  const [toast, setToast] = useState("");
  const flash = (t: string) => { setToast(t); setTimeout(() => setToast(""), 2500); };
  return (
    <div className="toolbar no-print">
      <button className="btn" type="button" onClick={() => window.print()}>Download PDF</button>
      <button className="btn" type="button" onClick={() => downloadText(`${g.slug}-oauth-readiness.md`, toMarkdown(g))}>Download Markdown</button>
      <button className="btn" type="button" onClick={async () => {
        try { await navigator.clipboard.writeText(`${location.origin}/guides/${g.slug}`); flash("Link copied"); }
        catch { flash(`${location.origin}/guides/${g.slug}`); }
      }}>Copy link</button>
      {extra}
      <span className="toast" role="status">{toast}</span>
    </div>
  );
}

export default function GuidePage({ g, canRegenerate }: { g: Guide; canRegenerate: boolean }) {
  const stale = (Date.now() - new Date(g.checkedOn).getTime()) / 86400000 > 30;
  return (
    <>
      <Link href="/" className="small no-print">&larr; All guides</Link>
      <Toolbar g={g} extra={canRegenerate && g.evidenceLevel === "generated" ? (
        <Link className="btn" href={`/?regenerate=${encodeURIComponent(g.name)}&website=${encodeURIComponent(g.website)}`}>Research again</Link>
      ) : null} />
      {stale && <div className="notice no-print">Checked more than 30 days ago. Provider rules change often; check the evidence table before relying on it.</div>}
      <GuideView g={g} />
    </>
  );
}
