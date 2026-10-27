// Simple per-IP limiter. In-memory, so it resets on cold starts; enough to stop a demo link being drained.
const hits = new Map<string, number[]>();

export function limited(req: Request, bucket: string, max: number, windowMs = 3_600_000): boolean {
  const ip = (req.headers.get("x-forwarded-for") || "local").split(",")[0].trim();
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (list.length >= max) { hits.set(key, list); return true; }
  list.push(now);
  hits.set(key, list);
  return false;
}
