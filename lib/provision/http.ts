// Shared bits for the provisioning routes: who may run the agent, the site's base URL, and the
// public view of a run (vault names and masked values only).
import "../env";
import { mockEnabled } from "./mock";
import type { Run } from "./types";

/**
 * Open by default: anyone with the link can run the agent in either mode (the create route is
 * rate limited per network). Setting PROVISION_ACCESS_CODE turns on an access code for real runs.
 * Mock mode (PROVISION_MOCK=1) is always open.
 */
export function gate(req: Request): Response | null {
  if (mockEnabled()) return null;
  const code = process.env.PROVISION_ACCESS_CODE;
  if (code && req.headers.get("x-access-code") !== code) return Response.json({ error: "Access code required.", needsCode: true }, { status: 401 });
  return null;
}

export function baseUrl(req: Request): string {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, "");
  const h = req.headers;
  const host = h.get("x-forwarded-host") || h.get("host") || "localhost:3000";
  const proto = h.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

export function publicRun(r: Run) {
  const { lockUntil, ...rest } = r;
  return { ...rest, busy: Boolean(lockUntil && lockUntil > Date.now()), mock: mockEnabled() };
}
