"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { AgentEvent } from "@/lib/agent/parse";
import { applyEvent, initialStages, type RunState } from "./ResearchView";
import type { SandboxCheck } from "@/lib/provision/types";
import { SetupParts } from "./ProvisionRun";

/** One line in the "What's happening" panel. Start and finish of the same step share an id. */
type Act = { id: string; label: string; state: "start" | "done" | "fail" | "info"; detail?: string; ms: number; dur?: number };

type Row = { id: string; app: string; mode: "human" | "auto"; status: string; strategy: string; createdAt: string; who?: string; signInOnly?: boolean };

export const codeHeader = (): Record<string, string> => {
  try { const c = sessionStorage.getItem("provision-code"); return c ? { "x-access-code": c } : {}; } catch { return {}; }
};

export default function ProvisionStart({ mock }: { mock: boolean }) {
  const router = useRouter();
  const [app, setApp] = useState("");
  const [mode, setMode] = useState<"human" | "auto">("human");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ text: string; research?: string; needsCode?: boolean; gated?: SandboxCheck } | null>(null);
  const [useCase, setUseCase] = useState("");
  const [code, setCode] = useState("");
  const [runs, setRuns] = useState<Row[]>([]);
  const [simulate, setSimulate] = useState(true);
  // Apps without a guide: the agent researches one first, saves it, then plans the run from it.
  const [research, setResearch] = useState<{ app: string; seconds: number; lines: string[] } | null>(null);
  // Everything the backend does after "Provision" is pressed, shown live like a network panel.
  const [acts, setActs] = useState<Act[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const t0 = useRef(0);
  const logEnd = useRef<HTMLLIElement | null>(null);

  function act(e: Omit<Act, "ms"> & { ms?: number }) {
    const ms = e.ms ?? Date.now() - t0.current;
    setActs((list) => {
      const i = list.findIndex((a) => a.id === e.id);
      if (i < 0) return [...list, { ...e, ms }];
      const prev = list[i];
      const next = [...list];
      next[i] = { ...prev, ...e, ms: prev.ms, dur: e.state === "done" || e.state === "fail" ? ms - prev.ms : prev.dur };
      return next;
    });
  }

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setElapsed(Math.round((Date.now() - t0.current) / 1000)), 1000);
    return () => clearInterval(t);
  }, [busy]);
  useEffect(() => { logEnd.current?.scrollIntoView({ block: "nearest" }); }, [acts.length]);

  useEffect(() => { fetch("/api/provision").then((r) => r.json()).then(setRuns).catch(() => undefined); }, []);

  /** Starts a run. The server streams each step it takes; the last line is the result. */
  async function create(name: string, guideSlug?: string): Promise<{ status: number; j: Record<string, any> }> {
    act({ id: `post:${guideSlug || ""}`, label: "POST /api/provision", state: "start", detail: `${name}, ${mode === "auto" ? "full automation" : "human in the loop"}${useCase.trim() ? `, use case "${useCase.trim().slice(0, 60)}"` : ""}` });
    const res = await fetch("/api/provision", { method: "POST", headers: { "content-type": "application/json", accept: "application/x-ndjson", ...codeHeader() }, body: JSON.stringify({ app: name, mode, simulateChange: mock && simulate, guideSlug, useCase: useCase.trim() || undefined }) });
    const base = Date.now() - t0.current;
    let out: { status: number; j: Record<string, any> } | null = null;
    if (!(res.headers.get("content-type") || "").includes("ndjson") || !res.body) {
      out = { status: res.status, j: await res.json().catch(() => ({ error: `HTTP ${res.status}` })) };
    } else {
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let ev: { type: string; ms?: number; status?: number; body?: Record<string, any> } & Partial<Act>;
          try { ev = JSON.parse(line); } catch { continue; }
          if (ev.type === "progress" && ev.id && ev.label && ev.state) act({ id: `${guideSlug || ""}:${ev.id}`, label: ev.label, state: ev.state, detail: ev.detail, ms: base + (ev.ms || 0) });
          if (ev.type === "result") out = { status: ev.status || 500, j: ev.body || {} };
        }
      }
      if (!out) out = { status: 502, j: { error: "The connection closed before the server finished. Try again." } };
    }
    act({ id: `post:${guideSlug || ""}`, label: "POST /api/provision", state: out.status < 300 ? "done" : out.status === 404 && out.j.noGuide ? "info" : "fail", detail: `${out.status}${out.status < 300 ? " run created" : out.j.noGuide ? " no guide yet" : out.j.gated ? " stopped: no self-serve test account" : ` ${String(out.j.error || "").slice(0, 120)}`}` });
    return out;
  }

  async function start(name = app) {
    if (!name.trim()) return;
    setBusy(true); setErr(null); setActs([]); setElapsed(0); t0.current = Date.now();
    try {
      let { status, j } = await create(name);
      if (status === 404 && j.noGuide) {
        const slug = await researchAndSave(name);
        if (!slug) return;
        ({ status, j } = await create(name, slug));
      }
      if (status >= 300) { setErr({ text: j.error, research: j.research, needsCode: j.needsCode, gated: j.gated }); return; }
      act({ id: "open", label: "Opening the run", state: "done", detail: `/provision/${j.id}` });
      router.push(`/provision/${j.id}`);
    } finally { setBusy(false); setResearch(null); }
  }

  /** Runs the research agent (the same one as /research), saves the guide, returns its slug. */
  async function researchAndSave(name: string): Promise<string | null> {
    setResearch({ app: name, seconds: 0, lines: ["Starting research…"] });
    act({ id: "research", label: "No guide yet: the research agent reads the vendor's developer docs", state: "start", detail: "POST /api/generate (usually 1 to 4 minutes)" });
    let tools = 0;
    const t0 = Date.now();
    const tick = setInterval(() => setResearch((r) => (r ? { ...r, seconds: Math.round((Date.now() - t0) / 1000) } : r)), 1000);
    const fallback = `/research?name=${encodeURIComponent(name)}`;
    try {
      const res = await fetch("/api/generate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
      if (!res.ok || !res.body) { setErr({ text: (await res.text()) || "The research agent is unavailable.", research: fallback }); return null; }
      let st: RunState = { guide: {}, stages: initialStages(), lines: [], counts: { search: 0, fetch: 0 } };
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
          if (ev.type === "error") { act({ id: "research", label: "No guide yet: the research agent reads the vendor's developer docs", state: "fail", detail: ev.message }); setErr({ text: `Research failed: ${ev.message}`, research: fallback }); return null; }
          if (ev.type === "tool") { tools++; act({ id: `research:tool:${tools}`, label: ev.kind === "search" ? `web_search "${ev.text}"` : ev.kind === "fetch" || ev.kind === "render" ? `${ev.kind === "render" ? "render" : "web_fetch"} ${ev.text}` : `load skill ${ev.text}`, state: "info" }); }
          if (ev.type === "section") act({ id: `research:section:${ev.section}`, label: `Guide section written: ${ev.section}`, state: "done" });
          st = applyEvent(st, ev);
          setResearch((r) => (r ? { ...r, lines: st.lines.slice(-6).map((l) => l.text) } : r));
        }
      }
      if (st.oauth && !st.oauth.supported) { setErr({ text: `${name} doesn't offer OAuth for third-party apps: ${st.oauth.note}` }); return null; }
      if (!st.guide.slug) { setErr({ text: "Research ended without a guide. Try again, or open the research page.", research: fallback }); return null; }
      act({ id: "research", label: "No guide yet: the research agent reads the vendor's developer docs", state: "done", detail: `guide written (${tools} web calls)` });
      setResearch((r) => (r ? { ...r, lines: [...r.lines, "Saving the guide, then planning the run…"] } : r));
      act({ id: "save-guide", label: "POST /api/guides", state: "start", detail: "saving the researched guide" });
      const save = await fetch("/api/guides", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ guide: st.guide, overwrite: false }) });
      // 409: a guide with this slug already exists, which is fine for planning.
      act({ id: "save-guide", label: "POST /api/guides", state: save.ok || save.status === 409 ? "done" : "fail", detail: save.ok ? `${save.status} saved` : save.status === 409 ? "409 already saved, reusing it" : `${save.status}` });
      if (!save.ok && save.status !== 409) { const r = await save.json().catch(() => ({})); setErr({ text: `Couldn't save the researched guide: ${r.error || save.status}`, research: fallback }); return null; }
      return st.guide.slug;
    } catch (e) {
      setErr({ text: (e as Error).message, research: fallback });
      return null;
    } finally { clearInterval(tick); }
  }

  function saveCode() {
    try { sessionStorage.setItem("provision-code", code.trim()); } catch { /* private mode */ }
    setErr(null); start();
  }

  return (
    <>
      <form className="ask" onSubmit={(e) => { e.preventDefault(); start(); }}>
        <input aria-label="App name" placeholder="App name, e.g. Linear" value={app} onChange={(e) => setApp(e.target.value)} />
        <button className="btn primary" disabled={busy || !app.trim()}>{busy ? <span className="spin" /> : null} Provision</button>
      </form>
      <label className="usecase">
        <span>What will the app do? <span className="muted">(optional, sets the scopes and the test call)</span></span>
        <textarea rows={2} placeholder="e.g. read invoices and create customers" value={useCase} onChange={(e) => setUseCase(e.target.value)} maxLength={600} />
      </label>
      <div className="modes" role="radiogroup" aria-label="Mode">
        <button type="button" role="radio" aria-checked={mode === "human"} className={`mode ${mode === "human" ? "on" : ""}`} onClick={() => setMode("human")}>
          <b>Human in the loop</b><span>You sign in. The agent does the rest and asks before every create, submit or consent.</span>
        </button>
        <button type="button" role="radio" aria-checked={mode === "auto"} className={`mode ${mode === "auto" ? "on" : ""}`} onClick={() => setMode("auto")}>
          <b>Full automation</b><span>The agent signs up with its own inbox and only stops at captchas, phone checks and legal steps.</span>
        </button>
      </div>
      <div className="tries">Try: {["Linear", "Slack", "HubSpot"].map((n) => <button key={n} type="button" className="chip" onClick={() => { setApp(n); start(n); }}>{n}</button>)}
        {mock ? <span className="badge st-unverified">Demo mode: simulated browser and providers</span> : null}
      </div>
      {mock ? (
        <label className="simulate">
          <input type="checkbox" checked={simulate} onChange={(e) => setSimulate(e.target.checked)} />
          Simulate a console change, so a step fails and the recovery agent has to find another route
        </label>
      ) : null}
      {acts.length ? (
        <section className="alog" aria-label="What's happening">
          <div className="alog-head">
            <b>{busy ? <><span className="spin" /> What&apos;s happening</> : "What happened"}</b>
            <span className="muted">{busy ? `${elapsed}s` : `${(Math.max(...acts.map((a) => a.ms + (a.dur || 0))) / 1000).toFixed(1)}s`} · {acts.length} steps and calls</span>
          </div>
          <ol>
            {acts.map((a, i) => (
              <li key={a.id} className={`al-${a.state}`} ref={i === acts.length - 1 ? logEnd : undefined}>
                <span className="al-t">+{(a.ms / 1000).toFixed(1)}s</span>
                <span className="al-i" aria-label={a.state}>{a.state === "start" ? <span className="spin" /> : a.state === "done" ? "✓" : a.state === "fail" ? "✗" : "·"}</span>
                <span className="al-l">{a.label}{a.dur !== undefined ? <span className="al-d"> {a.dur < 1000 ? `${a.dur}ms` : `${(a.dur / 1000).toFixed(1)}s`}</span> : null}{a.detail ? <span className="al-x">{a.detail}</span> : null}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {research ? (
        <div className="card" role="status" aria-live="polite">
          <p><span className="spin" /> <b>No guide for {research.app} yet.</b> The agent is reading {research.app}&apos;s developer docs to write one, then it plans the OAuth app from it. This usually takes 1 to 4 minutes. ({research.seconds}s)</p>
          <div className="small muted">{research.lines.map((l, i) => <div key={i}>{l}</div>)}</div>
        </div>
      ) : null}
      {err ? (
        <div className="card err" role="alert">
          {err.gated ? (
            <>
              <p><b>No self-serve test account.</b> The agent stopped before signing up or opening a browser.</p>
              <p>{err.gated.reason}</p>
              <SetupParts check={err.gated} />
            </>
          ) : <p>{err.text}</p>}
          {err.research ? <div className="row"><a className="btn" href={err.research}>Open the research page</a></div> : null}
          {err.needsCode ? (
            <form className="row" onSubmit={(e) => { e.preventDefault(); saveCode(); }}>
              <input className="field" type="password" placeholder="Access code" value={code} onChange={(e) => setCode(e.target.value)} aria-label="Access code" />
              <button className="btn primary">Continue</button>
            </form>
          ) : null}
        </div>
      ) : null}
      {runs.length ? (
        <section className="runs">
          <h2>Recent runs</h2>
          {runs.map((r) => (
            <a key={r.id} href={`/provision/${r.id}`} className="runrow">
              <b>{r.app}</b>
              <span className="muted">{r.mode === "auto" ? "Full automation" : "Human in the loop"} · {r.strategy}</span>
              <span className={`badge s-${r.status}`}>{r.signInOnly ? "verified, sign-in only" : r.status.replace("_", " ")}</span>
              <span className="small">{new Date(r.createdAt).toLocaleString()}</span>
            </a>
          ))}
        </section>
      ) : null}
    </>
  );
}
