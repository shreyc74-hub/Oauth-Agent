import { advance } from "@/lib/provision/engine";
import { listRuns } from "@/lib/provision/runs";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Background driver: Vercel calls this every minute (vercel.json). It moves every queued or running run
 * forward, so a run doesn't stall when nobody has its page open. Runs waiting for a person or an approval
 * are left alone; a run another call is advancing is skipped by its lease.
 * With CRON_SECRET set, only Vercel's cron (Authorization: Bearer <secret>) may call it.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) return new Response("unauthorized", { status: 401 });
  const active = (await listRuns(50)).filter((r) => (r.status === "running" || r.status === "queued") && !(r.lockUntil && r.lockUntil > Date.now()));
  const results = await Promise.allSettled(active.slice(0, 6).map((r) => advance(r.id, undefined, 240_000)));
  return Response.json({
    advanced: results.map((x, i) => ({ id: active[i].id, status: x.status === "fulfilled" ? x.value.status : `error: ${String((x as PromiseRejectedResult).reason?.message || x.reason).slice(0, 120)}` })),
  });
}
