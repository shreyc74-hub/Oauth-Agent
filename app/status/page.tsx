import "@/lib/env";
import { storeHealth } from "@/lib/store";
import { MODEL } from "@/lib/agent/claude";
import { renderProvider } from "@/lib/agent/render";

export const dynamic = "force-dynamic";
export const metadata = { title: "Status · OAuth Readiness Guides", robots: { index: false } };

/** Shows what the server sees. Never prints secret values, only whether they are set. */
export default async function Status() {
  const db = await storeHealth();
  const key = process.env.ANTHROPIC_API_KEY || "";
  const rows: [string, string, boolean][] = [
    ["Anthropic API key", key ? `Set (${key.length} characters, starts with ${key.slice(0, 7)}…)` : "Not set", Boolean(key)],
    ["Model", MODEL, true],
    ["Storage", db.mode === "supabase" ? `Supabase at ${db.url}` : "In memory (guides saved by the agent are lost on redeploy)", db.mode === "supabase"],
    ["Supabase read", db.mode === "supabase" ? (db.ok ? `OK · ${db.guides} guides in the table` : `Failing: ${db.error}`) : (db.error || "Not configured"), db.ok],
    ["Reading JavaScript pages", renderProvider(), renderProvider() !== "off"],
    ["Mock mode", process.env.AGENT_MOCK === "1" ? "On (no real research)" : "Off", process.env.AGENT_MOCK !== "1"],
  ];
  return (
    <main className="wrap">
      <div className="prose">
        <div className="eyebrow">Deployment status</div>
        <h1>What this server sees</h1>
        <p className="lede">Secret values are never shown, only whether they are set.</p>
        <div className="tablewrap"><table>
          <tbody>{rows.map(([k, v, ok]) => (
            <tr key={k}><td className="t">{k}</td><td><span className={`badge ${ok ? "st-tested" : "st-conflict"}`}>{ok ? "OK" : "Check"}</span> {v}</td></tr>
          ))}</tbody>
        </table></div>
      </div>
    </main>
  );
}
