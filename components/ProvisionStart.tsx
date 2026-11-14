"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

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

  useEffect(() => { fetch("/api/provision").then((r) => r.json()).then(setRuns).catch(() => undefined); }, []);

  async function start(name = app) {
    if (!name.trim()) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch("/api/provision", { method: "POST", headers: { "content-type": "application/json", ...codeHeader() }, body: JSON.stringify({ app: name, mode, simulateChange: mock && simulate }) });
      const j = await res.json();
      if (!res.ok) { setErr({ text: j.error, research: j.research, needsCode: j.needsCode }); return; }
      router.push(`/provision/${j.id}`);
    } finally { setBusy(false); }
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
      {err ? (
        <div className="card err" role="alert">
          <p>{err.text}</p>
          {err.research ? <div className="row"><a className="btn" href={err.research}>Create the guide first</a></div> : null}
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
