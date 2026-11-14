"use client";
// One provisioning run: steps on the left, the current handoff or approval, the live browser, the
// credential card and the audit log. The page drives the run: while it is running and nobody else
// holds the lease, it calls /advance; each call runs steps until a pause or the time budget.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Run } from "@/lib/provision/types";
import { codeHeader } from "./ProvisionStart";

type View = Run & { busy: boolean; mock: boolean };

const STATUS: Record<string, string> = {
  queued: "Queued", running: "Working", waiting_human: "Your turn", waiting_approval: "Needs your approval",
  verified: "Verified", needs_review: "Created, not verified", failed: "Failed", cancelled: "Cancelled",
};

export default function ProvisionRun({ id }: { id: string }) {
  const [run, setRun] = useState<View | null>(null);
  const [err, setErr] = useState("");
  const [value, setValue] = useState("");
  const [shown, setShown] = useState<{ label: string; value: string } | null>(null);
  const advancing = useRef(false);

  const load = useCallback(async () => {
    const r = await fetch(`/api/provision/${id}`, { cache: "no-store" });
    if (r.ok) setRun(await r.json()); else setErr("Run not found.");
  }, [id]);

  useEffect(() => { load(); const t = setInterval(load, 2500); return () => clearInterval(t); }, [load]);

  // Drive the run forward whenever it is ready to work.
  useEffect(() => {
    if (!run || advancing.current || run.busy) return;
    if (run.status !== "queued" && run.status !== "running") return;
    advancing.current = true;
    fetch(`/api/provision/${id}/advance`, { method: "POST", headers: codeHeader() })
      .then(async (r) => { const j = await r.json(); if (r.ok) setRun(j); else setErr(j.error || "Could not continue."); })
      .finally(() => { advancing.current = false; });
  }, [run, id]);

  async function answer(action: "continue" | "approve" | "skip" | "cancel", v?: string) {
    setErr("");
    const r = await fetch(`/api/provision/${id}/respond`, { method: "POST", headers: { "content-type": "application/json", ...codeHeader() }, body: JSON.stringify({ action, value: v }) });
    const j = await r.json();
    if (r.ok) { setRun(j); setValue(""); } else setErr(j.error);
  }

  async function revealSecret(label: string) {
    let token = "";
    if (!run?.mock) { token = window.prompt("Admin token to reveal this secret (the reveal is logged)") || ""; if (!token) return; }
    const r = await fetch(`/api/provision/${id}/reveal`, { method: "POST", headers: { "content-type": "application/json", "x-admin-token": token }, body: JSON.stringify({ label }) });
    const j = await r.json();
    if (!r.ok) { setErr(j.error); return; }
    setShown({ label, value: j.value });
    setTimeout(() => setShown(null), 30_000);
    load();
  }

  if (!run) return <main className="wrap"><p className="muted" style={{ padding: "40px 0" }}>{err || <><span className="spin" /> Loading run…</>}</p></main>;

  const p = run.pending;
  const done = ["verified", "needs_review", "failed", "cancelled"].includes(run.status);
  const live = run.browser?.liveUrl;
  const showLive = !done && live && /^https:/.test(live);

  return (
    <main className="ppage">
      <aside className="rside">
        <div className="eyebrow">{run.mode === "auto" ? "Full automation" : "Human in the loop"} · {run.strategy} strategy</div>
        <h1 className="ptitle">{run.app}</h1>
        <span className={`badge s-${run.status}`}>{run.status === "running" || run.busy ? <span className="spin" /> : null} {STATUS[run.status]}</span>
        <ol className="rsteps" aria-label="Steps">
          {run.steps.map((s, i) => (
            <li key={s.id} className={`rstep ${s.state === "done" ? "done" : s.state === "skipped" ? "skipped" : i === run.cursor && !done ? "active" : ""} ${s.state === "blocked" ? "blocked" : ""}`}>
              <span className="dot" aria-hidden />
              <div><div className="tt">{s.title}</div><div className="nt">{s.kind}{s.state === "skipped" ? " · skipped" : ""}{s.state === "blocked" ? " · waiting for you" : ""}</div></div>
            </li>
          ))}
        </ol>
        <div className="small" style={{ marginTop: 18 }}>Evidence for this plan: <b>{run.playbook.evidence}</b>. Sandbox: {run.playbook.sandbox.kind}.</div>
        {!done ? <button className="btn" style={{ marginTop: 16 }} onClick={() => { if (confirm("Cancel this run? The hosted browser is closed.")) answer("cancel"); }}>Cancel run</button> : null}
      </aside>

      <section className="rmain">
        <div className="mhead"><h1 className="ptitle">{run.app}</h1><span className={`badge s-${run.status}`}>{STATUS[run.status]}</span> <span className="small">step {Math.min(run.cursor + 1, run.steps.length)} of {run.steps.length}</span></div>
        {run.mock ? <div className="notice">Demo mode: the browser, inbox and provider APIs are simulated. Every step, pause and vault write runs for real.</div> : null}
        {err ? <div className="card err" role="alert"><p>{err}</p></div> : null}

        {p ? (
          <div className={`review ${p.kind === "approval" ? "approve" : "handoff"}`}>
            <div className="eyebrow">{p.kind === "approval" ? "Approve before the agent acts" : p.blocker ? `Handoff: ${p.blocker}` : "Handoff"}</div>
            <h2>{run.steps[run.cursor]?.title}</h2>
            <p>{p.reason}</p>
            {p.field ? (
              <form className="row" onSubmit={(e) => { e.preventDefault(); answer("continue", value); }}>
                <input className="field" type={p.field.secret ? "password" : "text"} placeholder={`Paste ${p.field.into.replace(/_/g, " ")}`} value={value} onChange={(e) => setValue(e.target.value)} aria-label={p.field.label} autoComplete="off" />
                <button className="btn primary" disabled={!value}>Save to vault</button>
              </form>
            ) : null}
            <div className="row">
              {p.kind === "approval"
                ? <><button className="btn primary" onClick={() => answer("approve")}>Approve</button><button className="btn" onClick={() => answer("cancel")}>Stop the run</button></>
                : <><button className="btn primary" onClick={() => answer("continue")}>Done, continue</button><button className="btn" onClick={() => answer("skip")}>Skip this step</button></>}
              {live && /^https:/.test(live) ? <a className="btn" href={live} target="_blank" rel="noreferrer">Open live browser</a> : null}
            </div>
          </div>
        ) : null}

        {showLive ? (
          <div className="live">
            <div className="small">Live browser{p?.kind === "human" ? ": you can click and type here" : ""}</div>
            <iframe src={live} title="Live browser" sandbox="allow-same-origin allow-scripts" allow="clipboard-read; clipboard-write" />
          </div>
        ) : null}

        <div className="creds">
          <h2>Credentials</h2>
          <dl>
            <dt>Client ID</dt><dd><code>{run.public.clientId || "not yet"}</code></dd>
            {run.public.appId ? <><dt>App ID</dt><dd><code>{run.public.appId}</code></dd></> : null}
            <dt>Agent identity</dt><dd>{run.identity?.email || (run.mode === "human" ? "your own sign-in" : "not yet")}</dd>
            <dt>Sandbox</dt><dd>{run.vars.workspace_name} <span className="muted">({run.playbook.sandbox.kind})</span></dd>
            <dt>Redirect URI</dt><dd><code>{run.vars.redirect_uri}</code></dd>
            <dt>Verified as</dt><dd>{run.verify?.who ? <span className="ok-text">{run.verify.who}</span> : run.vars.verify_error ? <span className="bad-text">{run.vars.verify_error}</span> : "not yet"}</dd>
            <dt>Refresh token</dt><dd>{run.verify?.refresh || "not yet"}</dd>
          </dl>
          {Object.keys(run.vault).length ? (
            <div className="vault">
              <div className="small">In the vault (values are never sent to this page unless an admin reveals one):</div>
              {Object.entries(run.vault).map(([label, name]) => (
                <div key={label} className="vrow">
                  <span><b>{label.replace(/_/g, " ")}</b> <code>{name}</code></span>
                  {shown?.label === label
                    ? <code className="revealed">{shown.value}</code>
                    : <button className="btn" onClick={() => revealSecret(label)}>Reveal</button>}
                </div>
              ))}
            </div>
          ) : null}
          {run.goLive ? (
            <div className={`callout ${run.goLive.needed ? "tone-warn" : ""}`}>
              <b>{run.goLive.needed ? "Going live needs a person" : "Nothing to approve to go live"}</b>
              <p style={{ margin: "4px 0 0" }}>{run.goLive.summary}</p>
              {run.goLive.humanWork.length ? <ul>{run.goLive.humanWork.map((w) => <li key={w}>{w}</li>)}</ul> : null}
            </div>
          ) : null}
        </div>

        <div className="activity">
          <div className="eyebrow">Audit log</div>
          <div className="lines">
            {[...run.events].reverse().map((e, i) => (
              <div key={i} className={`ev ev-${e.kind}`} title={e.text}><span className="t">{new Date(e.at).toLocaleTimeString()}</span> <span className="v">{e.kind}</span> {e.text}</div>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
