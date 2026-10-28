// Owner notifications: tells the site owner when someone uses the agent.
// Set NOTIFY_URL in the deployment to one of:
//   https://ntfy.sh/<long-random-topic>        phone push via the free ntfy app (no account)
//   https://hooks.slack.com/services/...        Slack incoming webhook
//   https://discord.com/api/webhooks/...        Discord webhook
// Sends the app name, the event and Vercel's coarse location (city, country). Never IPs or keys.
// Failures are swallowed: a notification must never break the product.

export type NotifyEvent = "research_started" | "research_finished" | "research_failed" | "guide_saved" | "chat";

const ICON: Record<NotifyEvent, string> = {
  research_started: "🔎", research_finished: "✅", research_failed: "⚠️", guide_saved: "💾", chat: "💬",
};

/** Coarse location from Vercel's edge headers, e.g. "Bengaluru, IN". Empty when not on Vercel. */
export function whereFrom(req?: Request): string {
  if (!req) return "";
  const h = req.headers;
  const dec = (v: string | null) => { try { return v ? decodeURIComponent(v) : ""; } catch { return v || ""; } };
  const city = dec(h.get("x-vercel-ip-city"));
  const country = h.get("x-vercel-ip-country") || "";
  return [city, country].filter(Boolean).join(", ");
}

export function formatNotification(event: NotifyEvent, text: string, where = ""): string {
  const clean = String(text || "").replace(/\s+/g, " ").trim().slice(0, 300);
  return `${ICON[event]} ${clean}${where ? ` · ${where}` : ""}`;
}

export function buildRequest(url: string, message: string): { url: string; init: RequestInit } | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "https:") return null;
  if (u.hostname === "hooks.slack.com") return { url, init: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: message }) } };
  if (u.hostname.endsWith("discord.com") || u.hostname.endsWith("discordapp.com")) return { url, init: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: message }) } };
  // ntfy and anything else that accepts a plain-text POST.
  return { url, init: { method: "POST", headers: { "content-type": "text/plain; charset=utf-8", title: "OAuth Readiness" }, body: message } };
}

export async function notify(event: NotifyEvent, text: string, req?: Request): Promise<void> {
  const target = (process.env.NOTIFY_URL || "").trim();
  if (!target || process.env.AGENT_MOCK === "1") return;
  const r = buildRequest(target, formatNotification(event, text, whereFrom(req)));
  if (!r) return;
  try { await fetch(r.url, { ...r.init, signal: AbortSignal.timeout(3000) }); } catch { /* never break the product */ }
}
