import { Suspense } from "react";
import { listGuides } from "@/lib/store";
import Explorer from "@/components/Explorer";
import LibraryTable from "@/components/LibraryTable";

export const dynamic = "force-dynamic";

export default async function Home() {
  const guides = await listGuides();
  const library = guides.filter((g) => g.evidenceLevel !== "generated");
  const generated = guides.filter((g) => g.evidenceLevel === "generated");
  const tested = library.filter((g) => g.evidenceLevel === "tested").length;
  const agentOn = Boolean(process.env.ANTHROPIC_API_KEY || process.env.AGENT_MOCK === "1");

  return (
    <main>
      <div className="wrap">
        <section className="hero">
          <div className="eyebrow">Provider OAuth apps · {library.length} guides · {tested} tested by creating real apps</div>
          <h1>How long until your users can connect?</h1>
          <p className="lede">Look up an app before you build. See which choices you can't undo, what stays capped until review, how long approval takes, and what an agent can do for you.</p>
          <Suspense fallback={null}><Explorer agentOn={agentOn} /></Suspense>
        </section>
        <LibraryTable rows={library} title="Library" />
        <LibraryTable rows={generated} title="Created by the agent" filters={false} note="Researched live from official docs. Not reviewed by a person." empty="None yet. Search for an app that isn't in the library to create the first one." />
      </div>
    </main>
  );
}
