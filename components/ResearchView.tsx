"use client";
// Live research: what the agent is doing on the left, the guide filling in on the right.
// When it finishes: the self-check result and the permission prompt (save / download / discard).
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type Guide, validateGuide } from "@/lib/schema";
import { STAGES, STAGE_LABEL, type AgentEvent, type Stage } from "@/lib/agent/parse";
import { BUDGET } from "@/lib/agent/budget";
import { toMarkdown } from "@/lib/markdown";
import GuideView from "./GuideView";
import { downloadText } from "./GuidePage";
import ChatPanel from "./ChatPanel";

type StageState = "pending" | "active" | "done" | "skipped";
type Line = { kind: string; text: string };
type Phase = "running" | "review" | "saving" | "saved" | "stopped" | "error" | "exists";

export interface RunState { oauth?: { supported: boolean; note: string }; guide: Partial<Guide>; stages: Record<Stage, StageState>; lines: Line[]; counts: { search: number; fetch: number }; selfcheck?: { counts: Record<string, number>; notes: string[] } }

/** Pure reducer for the event stream, exported for tests. */
export function applyEvent(state: RunState, ev: AgentEvent): RunState {
  const s: RunState = { ...state, guide: { ...state.guide }, stages: { ...state.stages }, counts: { ...state.counts } };
  if (ev.type === "section") {
    if (ev.section === "header") Object.assign(s.guide, ev.data as object, { evidenceLevel: "generated" });
    else if (ev.section === "evidence") { const d = ev.data as Pick<Guide, "evidence" | "sources">; s.guide.evidence = d.evidence; s.guide.sources = d.sources; }
    else (s.guide as Record<string, unknown>)[ev.section] = ev.data;
  } else if (ev.type === "stage") {
    if (ev.state === "active") {
      // Stages the agent never entered before this one count as skipped, not done.
      const idx = STAGES.indexOf(ev.stage);
      STAGES.slice(0, idx).forEach((k) => { if (s.stages[k] === "pending") s.stages[k] = "skipped"; if (s.stages[k] === "active") s.stages[k] = "done"; });
    }
    s.stages[ev.stage] = ev.state;
  } else if (ev.type === "tool") {
    if (ev.kind === "search") s.counts.search++;
    if (ev.kind === "fetch" || ev.kind === "render") s.counts.fetch++;
    s.lines = [...state.lines, { kind: ev.kind, text: ev.text }].slice(-60);
  } else if (ev.type === "status") {
    s.lines = [...state.lines, { kind: "status", text: ev.text }].slice(-60);
  } else if (ev.type === "selfcheck") {
    s.selfcheck = { counts: ev.counts, notes: ev.notes };
  } else if (ev.type === "oauth") {
    s.oauth = { supported: ev.supported, note: ev.note };
  }
  return s;
}

const VERB: Record<string, string> = { search: "Searching", fetch: "Reading", render: "Rendering", skill: "Loaded skill", status: "" };
export const initialStages = () => Object.fromEntries(STAGES.map((k) => [k, "pending"])) as Record<Stage, StageState>;

export default function ResearchView({ name, website, overwrite }: { name: string; website: string; overwrite: boolean }) {
  const router = useRouter();
  const [st, setSt] = useState<RunState>(() => ({ guide: {}, stages: initialStages(), lines: [], counts: { search: 0, fetch: 0 } }));
  const [phase, setPhase] = useState<Phase>("running");
  const [error, setError] = useState("");
  const [savedSlug, setSavedSlug] = useState("");
  const [seconds, setSeconds] = useState(0);
  const ctl = useRef<AbortController | null>(null);
  const started = useRef(false);
  // The chat reads the latest draft when a question is sent.
  const stRef = useRef(st); stRef.current = st;
  const phaseRef = useRef(phase); phaseRef.current = phase;

  async function run() {
    ctl.current?.abort();
    const c = new AbortController(); ctl.current = c;
    let local: RunState = { guide: {}, stages: initialStages(), lines: [], counts: { search: 0, fetch: 0 } };
    setSt(local);
    setPhase("running"); setError(""); setSeconds(0);
    try {
      const res = await fetch("/api/generate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, website }), signal: c.signal });
      if (!res.ok || !res.body) throw new Error((await res.text()) || "The research agent is unavailable.");
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n"); buf = parts.pop() || "";
        for (const line of parts) {
          if (!line.trim()) continue;
          let ev: AgentEvent;
          try { ev = JSON.parse(line); } catch { continue; }
          if (ev.type === "error") throw new Error(ev.message);
          local = applyEvent(local, ev);
          setSt(local);
        }
      }
      if (!local.guide.name) throw new Error("The connection closed before the agent wrote anything. Try again.");
      setPhase("review");
    } catch (e) {
      if ((e as Error).name === "AbortError") { setPhase("stopped"); return; }
      setError((e as Error).message); setPhase("error");
    }
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    run();
    return () => ctl.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (phase !== "running") return;
    const t = setInterval(() => setSeconds((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);

  async function save(force: boolean) {
    setPhase("saving");
    const res = await fetch("/api/guides", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ guide: st.guide, overwrite: force }) });
    const r = await res.json().catch(() => ({}));
    if (res.status === 409 && !force && !String(r.error || "").includes("library guide")) { setPhase("exists"); return; }
    if (!res.ok) { setError(r.error || "Could not save."); setPhase("error"); return; }
    setSavedSlug(r.slug); setPhase("saved");
    router.refresh();
  }

  const g = st.guide;
  const problems = phase === "review" || phase === "exists" ? validateGuide(g) : [];
  const mmss = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  const c = st.selfcheck?.counts;

  return (
    <>
      <div className="subbar">
        <div className="in">
          <div className="crumbs">
            <Link href="/">Library</Link><span className="sep">/</span>
            <b>{phase === "running" ? `Researching ${name}` : `${name}: generated guide`}</b>
            {website && <span className="small">{website}</span>}
          </div>
          <div className="toolbar">
            {phase === "running" && <><span className="timer" aria-label="Elapsed time">{mmss}</span><button className="btn" type="button" onClick={() => ctl.current?.abort()}>Stop</button></>}
            {(phase === "stopped" || phase === "error") && <button className="btn primary" type="button" onClick={run}>Start again</button>}
          </div>
        </div>
      </div>

      <div className="rpage">
        <aside className="rside" aria-label="What the agent is doing">
          <div className="eyebrow">What the agent is doing</div>
          <div className="rsteps">
            <div className="rstep done"><span className="dot" /><div><div className="tt">Identified the vendor</div><div className="nt">{name}{website && website.toLowerCase() !== name.toLowerCase() ? ` · ${website}` : ""}</div></div></div>
            <div className="rstep done"><span className="dot" /><div><div className="tt">Checked the library</div><div className="nt">{overwrite ? "Researching a saved guide again" : "No guide yet"}</div></div></div>
            {STAGES.map((k) => (
              <div key={k} className={`rstep ${st.stages[k]}`}>
                <span className="dot" />
                <div><div className="tt">{STAGE_LABEL[k].title}</div><div className="nt">{k === "oauth" && st.oauth
                  ? <span className={st.oauth.supported ? "ok-text" : "bad-text"}>{st.oauth.supported ? "Yes: " : "No: "}{st.oauth.note}</span>
                  : st.stages[k] === "skipped" ? "Skipped by the agent" : STAGE_LABEL[k].note}</div></div>
              </div>
            ))}
          </div>
          <div className="activity">
            <div className="eyebrow">Live activity</div>
            <div className="lines" aria-live="polite">
              {st.lines.length === 0 && <div>Starting…</div>}
              {st.lines.slice(-12).map((l, i) => <div key={i} title={l.text}>{VERB[l.kind] && <span className={`v v-${l.kind}`}>{VERB[l.kind]} </span>}{l.text}</div>)}
            </div>
          </div>
          <div className="budget"><span><b>{st.counts.search}</b> of {BUDGET.searches} searches</span><span><b>{st.counts.fetch}</b> of {BUDGET.fetches} pages read</span></div>
        </aside>

        <main className="rmain">
          {(phase === "review" || phase === "saving" || phase === "exists") && (
            <div className="review" role="region" aria-label="Save this guide">
              <div className="badges" style={{ marginTop: 0 }}><span className="badge ev-generated">Generated · not reviewed by a person</span></div>
              <h2>{phase === "exists" ? `A saved guide for ${g.name} already exists. Replace it?` : overwrite ? "Replace the saved guide with this one?" : "Save this guide to the library?"}</h2>
              <p>Saving gives it its own link that anyone can open. It stays marked as generated. Generated guides can never replace a tested one.</p>
              {st.selfcheck && st.selfcheck.notes.length > 0 && (<><b style={{ fontSize: 14 }}>Self-check notes</b><ul>{st.selfcheck.notes.map((n, i) => <li key={i}>{n}</li>)}</ul></>)}
              {problems.length > 0 && <div className="notice">This guide is incomplete and can't be saved: {problems.join("; ")}. You can still download it.</div>}
              <div className="row">
                {(phase === "exists" || overwrite)
                  ? <button className="btn primary lg" type="button" disabled={problems.length > 0 || phase === "saving"} onClick={() => save(true)}>Replace saved guide</button>
                  : <button className="btn primary lg" type="button" disabled={problems.length > 0 || phase === "saving"} onClick={() => save(false)}>{phase === "saving" ? "Saving…" : "Save to library"}</button>}
                <button className="btn lg" type="button" onClick={() => downloadText(`${g.slug || "guide"}-oauth-readiness.md`, toMarkdown(g as Guide))}>Download without saving</button>
                <button className="btn lg" type="button" onClick={() => window.print()}>PDF</button>
                <button className="btn lg" type="button" onClick={() => router.push("/")}>Discard</button>
              </div>
              {c && <div className="counts"><span>Self-check:</span><span><b>{c.docs || 0}</b> from official docs</span><span><b>{c.secondary || 0}</b> secondary</span><span><b>{c.unverified || 0}</b> not verified</span><span><b>{c.conflict || 0}</b> conflicts</span></div>}
            </div>
          )}
          {phase === "saved" && (
            <div className="review"><h2>Saved to the library.</h2><p>It has its own link now and is marked as generated.</p><div className="row"><Link className="btn primary lg" href={`/guides/${savedSlug}`}>Open the guide</Link><Link className="btn lg" href="/">Back to the library</Link></div></div>
          )}
          {phase === "stopped" && <div className="notice">Stopped. Nothing was saved.</div>}
          {phase === "error" && <div className="notice" style={{ background: "var(--bad-soft)" }}>{error}</div>}

          {(g.name || phase === "running") && <GuideView g={{ name, website, ...g }} streaming={phase === "running"} />}
        </main>

        <aside className="chatcol rchat no-print" aria-label={`Ask about ${name}`}>
          <ChatPanel
            name={name}
            subtitle={phase === "running" ? "Answers from the draft so far" : "Answers from this draft"}
            intro={`Ask about ${name} while the agent researches. Answers come from the draft as it's written, then the library and the web, and say which.`}
            suggestions={["Do I need my own OAuth app?", "What has it found so far?", "Compare with Slack"]}
            getDraft={() => ({ name, website, running: phaseRef.current === "running", guide: stRef.current.guide })}
          />
        </aside>
      </div>
    </>
  );
}
