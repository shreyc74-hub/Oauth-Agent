import "@/lib/env";
import ChatPanel from "@/components/ChatPanel";

export const metadata = { title: "Ask the agent · OAuth Readiness Guides" };
export const dynamic = "force-dynamic";

export default function Ask() {
  const agentOn = Boolean(process.env.ANTHROPIC_API_KEY || process.env.AGENT_MOCK === "1");
  return (
    <main className="askpage">
      {agentOn
        ? <ChatPanel suggestions={["Which apps can I launch without a review?", "Compare Slack and Linear approval", "How long does Google verification take?", "What about Calendly?"]} />
        : <div className="chat"><div className="top"><b>Ask the agent</b></div><p className="fine">The agent isn&apos;t configured on this deployment (no ANTHROPIC_API_KEY).</p></div>}
    </main>
  );
}
