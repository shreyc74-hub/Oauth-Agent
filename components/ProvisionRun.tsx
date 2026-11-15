"use client";
import type { SandboxCheck } from "@/lib/provision/types";
import { signInOnly, SIGN_IN_ONLY, SIGN_IN_ONLY_WHY } from "@/lib/provision/labels";
import { describeDcr } from "@/lib/provision/dcr";
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

const SANDBOX: Record<string, string> = { self_serve: "Self-serve", likely_self_serve: "Likely self-serve", gated: "Gated", unknown: "Not confirmed" };

const PART: Record<string, string> = { developer_account: "Developer side", sandbox: "Sandbox", oauth_app: "OAuth app" };

/** The sandbox check per part: developer side, sandbox, OAuth app. Shared with the start page. */
export function SetupParts({ check }: { check: SandboxCheck }) {
  const parts = check.parts?.length ? check.parts : null;
  if (!parts) {
    return check.quotes.length ? <ul className="quotes small">{check.quotes.map((q, i) => <li key={i} className={q.found ? "" : "muted"}><q>{q.quote}</q> <a href={q.url} target="_blank" rel="noreferrer">source</a>{q.found ? "" : " · not found on the page, ignored"}</li>)}</ul> : null;
  }
  return (
    <div className="parts">
      {parts.map((p) => (
        <div key={p.role} className="part">
          <div className="small"><b>{PART[p.role]}:</b> {p.name} <span className={`badge sb-${p.verdict}`}>{SANDBOX[p.verdict]}</span>{p.expires ? <span className="muted"> · expires: {p.expires}</span> : null}</div>
          <div className="small muted">{p.reason}</div>
          {p.humanPath ? <div className="small"><b>A person would need to:</b> {p.humanPath}</div> : null}
          {p.quotes.length ? <ul className="quotes small">{p.quotes.map((q, i) => (
            <li key={i} className={q.found ? "" : "muted"}><q>{q.quote}</q> <a href={q.url} target="_blank" rel="noreferrer">source</a> · {q.says === "yes" ? "self-serve" : "gated"}{q.found ? " · found on the page" : " · not found on the page, ignored"}</li>
          ))}</ul> : null}
          {p.probe ? <div className="small muted">Sign-up page {p.probe.url}: {p.probe.looks.replace("_", " ")}{p.probe.signals.length ? ` (${p.probe.signals.join(", ")})` : ""}</div> : null}
        </div>
      ))}
    </div>
  );
}

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
    const call = (token = "") => fetch(`/api/provision/${id}/reveal`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { "x-admin-token": token } : {}) }, body: JSON.stringify({ label }) });
    let r = await call();
    let j = await r.json();
    if (r.status === 401 && j.needsToken) {
      // Only when the deployment has PROVISION_ADMIN_TOKEN set.
      const token = window.prompt("Admin token to reveal this secret (the reveal is logged)") || "";
      if (!token) return;
      r = await call(token);
      j = await r.json();
    }
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
        <span className={`badge s-${run.status}`}>{run.status === "running" || run.busy ? <span className="spin" /> : null} {signInOnly(run) ? SIGN_IN_ONLY : STATUS[run.status]}</span>
        <ol className="rsteps" aria-label="Steps">
          {run.steps.map((s, i) => (
            <li key={s.id} className={`rstep ${s.state === "done" ? "done" : s.state === "skipped" ? "skipped" : i === run.cursor && !done ? "active" : ""} ${s.state === "blocked" ? "blocked" : ""}`}>
              <span className="dot" aria-hidden />
              <div><div className="tt">{s.title}</div><div className="nt">{s.kind}{s.recovered ? " · recovered by agent" : ""}{s.state === "skipped" ? " · skipped" : ""}{s.state === "blocked" ? " · waiting for you" : ""}</div></div>
            </li>
          ))}
        </ol>
        <div className="small" style={{ marginTop: 18 }}>Evidence for this plan: <b>{run.playbook.evidence}</b>. Sandbox: {run.playbook.sandbox.kind}.</div>
        {!done ? <button className="btn" style={{ marginTop: 16 }} onClick={() => { if (confirm("Cancel this run? The hosted browser is closed.")) answer("cancel"); }}>Cancel run</button> : null}
      </aside>

      <section className="rmain">
        <div className="mhead"><h1 className="ptitle">{run.app}</h1><span className={`badge s-${run.status}`}>{signInOnly(run) ? SIGN_IN_ONLY : STATUS[run.status]}</span> <span className="small">step {Math.min(run.cursor + 1, run.steps.length)} of {run.steps.length}</span></div>
        {run.mock ? <div className="notice">Demo mode: the browser, inbox and provider APIs are simulated. Every step, pause and vault write runs for real.</div> : null}
        {err ? <div className="card err" role="alert"><p>{err}</p></div> : null}

        {p ? (
          <div className={`review ${p.kind === "approval" ? "approve" : "handoff"}`}>
            <div className="eyebrow">{p.recovery ? "The recovery agent wants to act" : p.kind === "approval" ? "Approve before the agent acts" : p.blocker ? `Handoff: ${p.blocker}` : "Handoff"}</div>
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

        {run.dcr ? (
          <div className="creds" style={{ marginBottom: 18 }}>
            <h2>Creating the app without a browser</h2>
            <p className="small"><span className={`badge ${run.dcr.available ? "sb-self_serve" : "sb-unknown"}`}>{run.dcr.available ? "Dynamic Client Registration offered" : "No Dynamic Client Registration"}</span></p>
            <p className="small">{describeDcr(run.dcr)}</p>
            {run.dcr.found.length ? <ul className="small">{run.dcr.found.map((f) => <li key={f.url}><code>{f.url}</code> {f.kind === "mcp" ? "(MCP)" : ""} {f.registration ? "· registration endpoint" : "· no registration endpoint"}</li>)}</ul> : null}
            <p className="small muted">Checked {run.dcr.checkedOn}. Read-only: nothing was registered.</p>
          </div>
        ) : null}
        {run.sandbox || run.scopePlan ? (
          <div className="creds" style={{ marginBottom: 18 }}>
            {run.sandbox ? (
              <>
                <h2>Sandbox check</h2>
                <p className="small"><span className={`badge sb-${run.sandbox.verdict}`}>{SANDBOX[run.sandbox.verdict]}</span> <span className="muted">from {run.sandbox.source === "run" ? "a verified run" : run.sandbox.source === "playbook" ? "the hand-written playbook" : `research on ${run.sandbox.checkedOn}`}</span></p>
                <p className="small">{run.sandbox.reason}</p>
                {run.sandbox.relation ? <p className="small">Sandbox is <b>{run.sandbox.relation === "same" ? "the same account" : run.sandbox.relation === "separate" ? "a separate account" : "not confirmed as same or separate"}</b> as the developer side.{run.sandbox.credential?.apiKey && run.sandbox.credential.oauth !== "self_serve" ? " An API key is self-serve." : ""}</p> : null}
                <SetupParts check={run.sandbox} />
              </>
            ) : null}
            {run.scopePlan ? (
              <>
                <h2 style={{ marginTop: run.sandbox ? 16 : 0 }}>Scopes for the use case</h2>
                <p className="small"><b>Use case:</b> {run.scopePlan.useCase}</p>
                <ul className="small">{run.scopePlan.mapping.map((m, i) => <li key={i}>{m.need}: <code>{m.scopes.join(" ")}</code> <span className="muted">{m.why}</span></li>)}</ul>
                {run.scopePlan.testCall ? <p className="small">Verification also calls <code>GET {run.scopePlan.testCall.url}</code> ({run.scopePlan.testCall.label}).</p> : <p className="small muted">No test call chosen; verification uses the identity call only.</p>}
                {run.scopePlan.notes.map((n, i) => <p key={i} className="small muted">{n}</p>)}
              </>
            ) : null}
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
            {!run.scopePlan ? <><dt>Scopes checked</dt><dd>{signInOnly(run) ? <span className="wait-text">{SIGN_IN_ONLY_WHY}</span> : <span className="muted">no use case given; scopes from the plan ({run.playbook.oauth.scopes.join(", ")})</span>}</dd></> : null}
            {run.scopePlan ? <><dt>Use-case call</dt><dd>{run.verify?.useCase ? <span className={run.verify.useCaseOk ? "ok-text" : "bad-text"}>{run.verify.useCase}</span> : run.scopePlan.testCall ? `not yet (${run.scopePlan.testCall.label})` : "none chosen"}</dd></> : null}
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

        {run.fixes?.length ? (
          <div className="fixes">
            <h2>Suggested playbook fixes</h2>
            <p className="small">The recovery agent found another route. A person reviews these before the playbook changes.</p>
            {run.fixes.map((f, i) => (
              <div key={i} className="fix"><b>{run.steps.find((s) => s.id === f.step)?.title || f.step}</b><p>{f.suggestion}</p></div>
            ))}
          </div>
        ) : null}

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
