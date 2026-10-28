"use client";
// Chat with the agent. Shows the tools it uses as it works, turns [§08 slack] citations into
// links, and renders the agent's proposals: "Research X" buttons and approval cards for writes.
import { Fragment, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { SECTION_TITLES } from "@/lib/schema";
import type { ChatAction, ChatEvent } from "@/lib/agent/chat";
import { Rich } from "./GuideView";

type Decision = "approved" | "denied" | "saving" | "error";
type Msg = { role: "user" | "assistant"; content: string; tools?: string[]; actions?: ChatAction[]; error?: string };

const NUM_TO_KEY = Object.fromEntries(Object.entries(SECTION_TITLES).filter(([, v]) => v.num).map(([k, v]) => [v.num, k]));

/** Splits text into plain parts and section citations like [§08] or [§08 slack]. Exported for tests. */
export function parseCites(text: string): ({ t: "text"; v: string } | { t: "cite"; num: string; key: string; slug?: string })[] {
  const out: ({ t: "text"; v: string } | { t: "cite"; num: string; key: string; slug?: string })[] = [];
  const re = /\[§\s?(\d{1,2})(?:[\s,]+([a-z0-9-]+))?\]/gi;
  let last = 0; let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const num = m[1].padStart(2, "0");
    const key = NUM_TO_KEY[num];
    if (!key) continue;
    if (m.index > last) out.push({ t: "text", v: text.slice(last, m.index) });
    out.push({ t: "cite", num, key, slug: m[2]?.toLowerCase() });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ t: "text", v: text.slice(last) });
  return out;
}

function Inline({ text, slug }: { text: string; slug?: string }) {
  return (
    <>
      {parseCites(text).map((p, i) => {
        if (p.t === "cite") {
          const href = !p.slug || p.slug === slug ? `#s-${p.key}` : `/guides/${p.slug}#s-${p.key}`;
          return <a key={i} className="cite" href={href}>§{p.num} {SECTION_TITLES[p.key].title}{p.slug && p.slug !== slug ? ` · ${p.slug}` : ""}</a>;
        }
        // **bold** then `code`
        return <Fragment key={i}>{p.v.split(/(\*\*[^*]+\*\*)/g).map((b, j) => b.startsWith("**") && b.endsWith("**") ? <b key={j}><Rich text={b.slice(2, -2)} /></b> : <Rich key={j} text={b} />)}</Fragment>;
      })}
    </>
  );
}

function Answer({ text, slug }: { text: string; slug?: string }) {
  const blocks = text.trim().split(/\n{2,}/);
  return (
    <>
      {blocks.map((b, i) => {
        const lines = b.split("\n");
        if (lines.every((l) => /^\s*([-*]|\d+\.)\s+/.test(l))) {
          return <ul key={i}>{lines.map((l, j) => <li key={j}><Inline text={l.replace(/^\s*([-*]|\d+\.)\s+/, "")} slug={slug} /></li>)}</ul>;
        }
        return <p key={i}>{lines.map((l, j) => <Fragment key={j}>{j > 0 && <br />}<Inline text={l.replace(/^#+\s*/, "")} slug={slug} /></Fragment>)}</p>;
      })}
    </>
  );
}

export default function ChatPanel({ slug, name, suggestions, intro, getDraft, subtitle }: { slug?: string; name?: string; suggestions: string[]; intro?: string; getDraft?: () => unknown; subtitle?: string }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const notes = useRef<string[]>([]);
  const end = useRef<HTMLDivElement>(null);
  const ctl = useRef<AbortController | null>(null);

  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [msgs]);
  useEffect(() => () => ctl.current?.abort(), []);

  async function ask(text: string) {
    const question = text.trim();
    if (!question || busy) return;
    const prefix = notes.current.length ? `(${notes.current.join(" ")})\n\n` : "";
    notes.current = [];
    const history = [...msgs.filter((m) => m.content.trim()).map((m) => ({ role: m.role, content: m.content })), { role: "user" as const, content: prefix + question }];
    const next: Msg[] = [...msgs, { role: "user", content: question }, { role: "assistant", content: "", tools: [], actions: [] }];
    setMsgs(next); setQ(""); setBusy(true);
    const update = (fn: (m: Msg) => Msg) => setMsgs((all) => { const c = all.slice(); c[c.length - 1] = fn({ ...c[c.length - 1] }); return c; });
    const c = new AbortController(); ctl.current = c;
    try {
      const res = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug, messages: history, draft: getDraft?.() }), signal: c.signal });
      if (!res.ok || !res.body) throw new Error((await res.text()) || "The agent is unavailable.");
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let ev: ChatEvent;
          try { ev = JSON.parse(line); } catch { continue; }
          if (ev.type === "text") update((m) => ({ ...m, content: m.content + ev.delta }));
          if (ev.type === "tool") update((m) => ({ ...m, tools: [...(m.tools || []), ev.text] }));
          if (ev.type === "action") update((m) => ({ ...m, actions: [...(m.actions || []), ev.action] }));
          if (ev.type === "error") throw new Error(ev.message);
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") update((m) => ({ ...m, error: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  }

  async function decide(a: Extract<ChatAction, { kind: "approve" }>, ok: boolean) {
    if (!ok) { setDecisions((d) => ({ ...d, [a.id]: "denied" })); notes.current.push(`I declined: ${a.title}`); return; }
    setDecisions((d) => ({ ...d, [a.id]: "saving" }));
    const res = await fetch("/api/corrections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(a.payload) });
    setDecisions((d) => ({ ...d, [a.id]: res.ok ? "approved" : "error" }));
    notes.current.push(res.ok ? `I approved: ${a.title} It was saved for review.` : `I approved: ${a.title} But saving failed.`);
  }

  return (
    <div className="chat">
      <div className="top"><b>{name ? `Ask about ${name}` : "Ask the agent"}</b><span className="small">{subtitle ?? (name ? "Answers from this guide" : "Answers from the library and the web")}</span></div>
      <div className="msgs" aria-live="polite">
        {msgs.length === 0 && <p className="intro">{intro ?? (name ? `Ask anything about getting a ${name} app approved, its limits, scopes or tokens. You can also compare it with other apps in the library.` : "Ask about any app: whether you need your own OAuth app, how long approval takes, what's capped until review. If an app has no guide yet, the agent offers to research it.")}</p>}
        {msgs.map((m, i) => m.role === "user" ? <div key={i} className="me">{m.content}</div> : (
          <div key={i} className="bot">
            {(m.tools || []).length > 0 && <div className="tools">{m.tools!.map((t, j) => <span key={j}>{t}</span>)}</div>}
            {m.content ? <Answer text={m.content} slug={slug} /> : !m.error && busy && i === msgs.length - 1 && <span className="small"><span className="spin" /> Thinking…</span>}
            {(m.actions || []).map((a, j) => a.kind === "research" ? (
              <div key={j} className="act">
                <b>No guide for {a.name} yet</b>
                <span className="small">Research takes 2 to 4 minutes. Nothing is saved until you approve it.</span>
                <div className="row"><Link className="btn primary" href={`/research?${new URLSearchParams({ name: a.name, website: a.website })}`}>Research {a.name}</Link></div>
              </div>
            ) : (
              <div key={j} className="act approve">
                <b>{a.title}</b>
                <pre>{a.detail}</pre>
                {decisions[a.id] === "approved" ? <span className="small">Saved for review. A person checks it before the guide changes.</span>
                  : decisions[a.id] === "denied" ? <span className="small">Not saved.</span>
                  : decisions[a.id] === "error" ? <span className="small">Saving failed. Try again later.</span>
                  : <div className="row"><button className="btn primary" type="button" disabled={decisions[a.id] === "saving"} onClick={() => decide(a, true)}>Approve</button><button className="btn" type="button" onClick={() => decide(a, false)}>Don&apos;t save</button></div>}
              </div>
            ))}
            {m.error && <div className="small" style={{ color: "var(--bad)" }}>{m.error}</div>}
          </div>
        ))}
        <div ref={end} />
      </div>
      {msgs.length === 0 && suggestions.length > 0 && <div className="sugg">{suggestions.map((s) => <button key={s} type="button" className="chip" onClick={() => ask(s)}>{s}</button>)}</div>}
      <form onSubmit={(e) => { e.preventDefault(); ask(q); }}>
        <label className="sr" htmlFor={`ask-${slug || "lib"}`}>Ask a question</label>
        <input id={`ask-${slug || "lib"}`} value={q} onChange={(e) => setQ(e.target.value)} placeholder={name ? "Ask anything about this guide" : "Ask about any app"} disabled={busy} autoComplete="off" />
        {busy ? <button className="btn" type="button" onClick={() => ctl.current?.abort()}>Stop</button> : <button className="btn primary" type="submit" disabled={!q.trim()}>Ask</button>}
      </form>
      <div className="fine">Answers cite guide sections. If the guide doesn&apos;t cover it, the agent says so. Anything it wants to save waits for your approval.</div>
    </div>
  );
}
