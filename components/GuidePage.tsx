"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { type Guide, SECTION_TITLES } from "@/lib/schema";
import { toMarkdown } from "@/lib/markdown";
import GuideView from "./GuideView";
import ChatPanel from "./ChatPanel";

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
      <span className="toast" role="status">{toast}</span>
      {extra}
      <button className="btn" type="button" onClick={() => window.print()}>Download PDF</button>
      <button className="btn" type="button" onClick={() => downloadText(`${g.slug}-oauth-readiness.md`, toMarkdown(g))}>Markdown</button>
      <button className="btn" type="button" onClick={async () => {
        const url = `${location.origin}/guides/${g.slug}`;
        try { await navigator.clipboard.writeText(url); flash("Link copied"); } catch { flash(url); }
      }}>Copy link</button>
    </div>
  );
}

/** Sections present in this guide, in order. */
export function tocFor(g: Guide): string[] {
  const keys = Object.keys(SECTION_TITLES);
  if (g.oauth?.supported === false) return ["evidence"];
  return keys.filter((k) => (g as unknown as Record<string, unknown>)[k] !== undefined);
}

function Toc({ keys }: { keys: string[] }) {
  const [on, setOn] = useState(keys[0]);
  useEffect(() => {
    const els = keys.map((k) => document.getElementById(`s-${k}`)).filter(Boolean) as HTMLElement[];
    const io = new IntersectionObserver((entries) => {
      const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (vis[0]) setOn(vis[0].target.id.slice(2));
    }, { rootMargin: "-80px 0px -60% 0px" });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [keys]);
  return (
    <nav className="toc" aria-label="Sections">
      <div className="t">On this page</div>
      {keys.map((k) => <a key={k} href={`#s-${k}`} className={on === k ? "on" : ""}><span>{SECTION_TITLES[k].num}</span>{SECTION_TITLES[k].title}</a>)}
    </nav>
  );
}

export function suggestionsFor(g: Guide, others: { slug: string; name: string }[]): string[] {
  const out: string[] = [];
  if (g.oauth?.supported === false) return [`What should I use instead of OAuth for ${g.name}?`];
  out.push("What do I need for review?");
  const set = g.scopes?.minimalSets?.[0];
  if (set) out.push(`Minimal scopes for ${set.label.toLowerCase()}`);
  else out.push("Which scopes should I start with?");
  const other = others.find((o) => o.slug !== g.slug);
  if (other) out.push(`Compare with ${other.name}`);
  return out;
}

export default function GuidePage({ g, canRegenerate, agentOn, others, corrections }: { g: Guide; canRegenerate: boolean; agentOn: boolean; others: { slug: string; name: string }[]; corrections: number }) {
  const stale = (Date.now() - new Date(g.checkedOn).getTime()) / 86400000 > 30;
  return (
    <>
      <div className="subbar">
        <div className="in">
          <div className="crumbs"><Link href="/">Library</Link><span className="sep">/</span><b>{g.name}</b></div>
          <Toolbar g={g} extra={canRegenerate && g.evidenceLevel === "generated" ? (
            <Link className="btn" href={`/?regenerate=${encodeURIComponent(g.name)}&website=${encodeURIComponent(g.website)}`}>Research again</Link>
          ) : null} />
        </div>
      </div>
      <div className="gpage">
        <Toc keys={tocFor(g)} />
        <main className="gmain">
          {stale && <div className="notice no-print" style={{ marginTop: 0, marginBottom: 20 }}>Checked more than 30 days ago. Provider rules change often; check the evidence table before relying on it{g.evidenceLevel === "generated" && canRegenerate ? ", or research it again" : ""}.</div>}
          {corrections > 0 && <div className="notice no-print" style={{ marginTop: 0, marginBottom: 20 }}>{corrections} correction{corrections > 1 ? "s" : ""} from developers waiting for review.</div>}
          <GuideView g={g} />
        </main>
        <aside className="chatcol no-print" aria-label={`Ask about ${g.name}`}>
          {agentOn
            ? <ChatPanel slug={g.slug} name={g.name} suggestions={suggestionsFor(g, others)} />
            : <div className="chat"><div className="top"><b>Ask about {g.name}</b></div><p className="fine">The agent isn&apos;t configured on this deployment (no API key).</p></div>}
        </aside>
      </div>
    </>
  );
}
