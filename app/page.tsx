import Link from "next/link";
import { Suspense } from "react";
import { listGuides } from "@/lib/store";
import Explorer from "@/components/Explorer";
import { Meter } from "@/components/GuideView";

export const dynamic = "force-dynamic";

const EV = { tested: "Tested", docs: "Docs-checked", generated: "Generated" } as const;
const tone = (n: number) => (n <= 2 ? "g" : n === 3 ? "a" : "r") as "g" | "a" | "r";

export default async function Home() {
  const guides = await listGuides();
  const library = guides.filter((g) => g.evidenceLevel !== "generated");
  const generated = guides.filter((g) => g.evidenceLevel === "generated");
  const agentOn = Boolean(process.env.ANTHROPIC_API_KEY || process.env.AGENT_MOCK === "1");

  return (
    <>
      <section className="hero">
        <div className="eyebrow">Provider OAuth apps · {library.length} guides in the library</div>
        <h1>How long until your users can connect?</h1>
        <p className="lede">Look up an app to see whether you need your own OAuth app, which choices you can't undo, what stays capped until review, how long approval takes, and which steps an agent can do for you.</p>
        <Suspense fallback={null}><Explorer agentOn={agentOn} /></Suspense>
      </section>

      <div className="sectionhead"><h2>Library</h2><span className="small">Tested = we created a real app · Docs-checked = verified against official docs</span></div>
      <div className="grid">{library.map((g) => <Card key={g.slug} g={g} />)}</div>

      <div className="sectionhead"><h2>Created by the agent</h2><span className="small">Researched live, not reviewed by a person</span></div>
      {generated.length ? <div className="grid">{generated.map((g) => <Card key={g.slug} g={g} />)}</div> : <p className="small">None yet. Search for an app that isn't in the library to create the first one.</p>}
    </>
  );

  function Card({ g }: { g: (typeof guides)[number] }) {
    return (
      <Link href={`/guides/${g.slug}`} className="card">
        <div className="row"><h3>{g.name}</h3><span className="cat">{g.category}</span></div>
        <div className="meters">
          <span>Create</span><span><Meter n={g.creation} tone={tone(g.creation)} /></span>
          <span>Approve</span><span><Meter n={g.approval} tone={tone(g.approval)} /></span>
        </div>
        <p>{g.verdict}</p>
        <div className="foot"><span>Wait: {g.waiting}</span><span className={`badge ev-${g.evidenceLevel}`}>{EV[g.evidenceLevel]}</span></div>
      </Link>
    );
  }
}
