// Run a provisioning job from the terminal (no time limits, no web server needed for the steps).
//   npm run provision -- linear            human in the loop
//   npm run provision -- slack --auto      full automation
// Handoffs print the live-browser link and wait for Enter. Approvals wait for "y".
// Without Supabase, the vault is in memory: the run's secrets disappear when the script exits.
import { createInterface } from "node:readline/promises";
import { createRun, advance, respond, isTerminal } from "../lib/provision/engine";

const args = process.argv.slice(2);
const app = args.find((a) => !a.startsWith("--"));
const mode = args.includes("--auto") ? "auto" : "human";
const base = process.env.PUBLIC_BASE_URL || "http://localhost:3000";

(async () => {
  if (!app) { console.log("Usage: npm run provision -- <app> [--auto]"); process.exit(1); }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let run = await createRun({ app, mode, baseUrl: base });
  console.log(`Run ${run.id}: ${run.app}, ${run.mode === "auto" ? "full automation" : "human in the loop"}, ${run.steps.length} steps`);
  let shown = 0;
  const print = () => { for (const e of run.events.slice(shown)) console.log(`  ${e.kind.padEnd(8)} ${e.text}`); shown = run.events.length; };
  print();
  while (!isTerminal(run)) {
    run = await advance(run.id, undefined, 30 * 60_000);
    print();
    if (run.pending) {
      if (run.browser?.liveUrl) console.log(`\n  Live browser: ${run.browser.liveUrl}`);
      if (run.pending.kind === "approval") {
        const a = (await rl.question("  Approve? [y/N] ")).trim().toLowerCase();
        run = await respond(run.id, a === "y" ? "approve" : "cancel");
      } else if (run.pending.field) {
        const v = (await rl.question(`  Paste ${run.pending.field.into} (or Enter to retry): `)).trim();
        run = await respond(run.id, "continue", v || undefined);
      } else {
        await rl.question("  Press Enter when done… ");
        run = await respond(run.id, "continue");
      }
      print();
    }
  }
  console.log(`\nStatus: ${run.status}${run.verify?.who ? ` (token works for ${run.verify.who})` : ""}`);
  console.log(`Client ID: ${run.public.clientId || "-"}`);
  for (const [k, v] of Object.entries(run.vault)) console.log(`Vault: ${k} -> ${v}`);
  rl.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
