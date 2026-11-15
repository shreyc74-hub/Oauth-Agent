"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { AgentEvent } from "@/lib/agent/parse";
import { applyEvent, initialStages, type RunState } from "./ResearchView";

type Row = { id: string; app: string; mode: "human" | "auto"; status: string; strategy: string; createdAt: string; who?: string };

export const codeHeader = (): Record<string, string> => {
  try { const c = sessionStorage.getItem("provision-code"); return c ? { "x-access-code": c } : {}; } catch { return {}; }
};

export default function ProvisionStart({ mock }: { mock: boolean }) {
  const router = useRouter();
  const [app, setApp] = useState("");
  const [mode, setMode] = useState<"human" | "auto">("human");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ text: string; research?: string; needsCode?: boolean } | null>(null);
  const [code, setCode] = useState("");
  const [runs, setRuns] = useState<Row[]>([]);
  const [simulate, setSimulate] = useState(true);
  // Apps without a guide: the agent researches one first, saves it, then plans the run from it.
  const [research, setResearch] = useState<{ app: string; seconds: number; lines: string[] } | null>(null);

  useEffect(() => { fetch("/api/provision").then((r) => r.json()).then(setRuns).catch(() => undefined); }, []);

  async function create(name: string, guideSlug?: string) {
    const res = await fetch("/api/provision", { method: "POST", headers: { "content-type": "application/json", ...codeHeader() }, body: JSON.stringify({ app: name, mode, simulateChange: mock && simulate, guideSlug }) });
    return { res, j: await res.json() };
  }

  async function start(name = app) {
    if (!name.trim()) return;
    setBusy(true); setErr(null);
    try {
      let { res, j } = await create(name);
      if (res.status === 404 && j.noGuide) {
        const slug = await researchAndSave(name);
        if (!slug) return;
        ({ res, j } = await create(name, slug));
      }
      if (!res.ok) { setErr({ text: j.error, research: j.research, needsCode: j.needsCode }); return; }
      router.push(`/provision/${j.id}`);
    } finally { setBusy(false); setResearch(null); }
  }

  /** Runs the research agent (the same one as /research), saves the guide, returns its slug. */
  async function researchAndSave(name: string): Promise<string | null> {
    setResearch({ app: name, seconds: 0, lines: ["Starting research…"] });
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
          if (ev.type === "error") { setErr({ text: `Research failed: ${ev.message}`, research: fallback }); return null; }
          st = applyEvent(st, ev);
          setResearch((r) => (r ? { ...r, lines: st.lines.slice(-6).map((l) => l.text) } : r));
        }
      }
      if (st.oauth && !st.oauth.supported) { setErr({ text: `${name} doesn't offer OAuth for third-party apps: ${st.oauth.note}` }); return null; }
      if (!st.guide.slug) { setErr({ text: "Research ended without a guide. Try again, or open the research page.", research: fallback }); return null; }
      setResearch((r) => (r ? { ...r, lines: [...r.lines, "Saving the guide, then planning the run…"] } : r));
      const save = await fetch("/api/guides", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ guide: st.guide, overwrite: false }) });
      // 409: a guide with this slug already exists, which is fine for planning.
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
      {research ? (
        <div className="card" role="status" aria-live="polite">
          <p><span className="spin" /> <b>No guide for {research.app} yet.</b> The agent is reading {research.app}&apos;s developer docs to write one, then it plans the OAuth app from it. This usually takes 1 to 4 minutes. ({research.seconds}s)</p>
          <div className="small muted">{research.lines.map((l, i) => <div key={i}>{l}</div>)}</div>
        </div>
      ) : null}
      {err ? (
        <div className="card err" role="alert">
          <p>{err.text}</p>
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
              <span className={`badge s-${r.status}`}>{r.status.replace("_", " ")}</span>
              <span className="small">{new Date(r.createdAt).toLocaleString()}</span>
            </a>
          ))}
        </section>
      ) : null}
    </>
  );
}
