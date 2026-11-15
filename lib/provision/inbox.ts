// The agent's email identity: one AgentMail inbox per provider run, read over the REST API.
// Codes and links are pulled out with plain code, never by the model, so they stay out of prompts.
import "../env";

const BASE = "https://api.agentmail.to/v0";

export interface Mail { id: string; from: string; subject: string; text: string; html: string; at: string }

export interface Inbox {
  create(username: string): Promise<{ inboxId: string; email: string }>;
  /** An existing inbox (PROVISION_INBOX_ID): one mailbox for every run. */
  get(inboxId: string): Promise<{ inboxId: string; email: string }>;
  list(inboxId: string): Promise<Mail[]>;
}

async function call(path: string, init: RequestInit = {}) {
  const key = process.env.AGENTMAIL_API_KEY;
  if (!key) throw Object.assign(new Error("AGENTMAIL_API_KEY is not set. Full automation needs an agent inbox; use human-in-the-loop mode instead"), { name: "ConfigError" });
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...(init.headers || {}) } });
  if (!res.ok) throw new Error(`AgentMail ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export const agentMail: Inbox = {
  async create(username) {
    const r = await call("/inboxes", { method: "POST", body: JSON.stringify({ username, display_name: "Toolkit Agent", client_id: username }) });
    return { inboxId: r.inbox_id, email: r.email || r.inbox_id };
  },
  async get(inboxId) {
    const r = await call(`/inboxes/${encodeURIComponent(inboxId)}`);
    return { inboxId: r.inbox_id, email: r.email || r.inbox_id };
  },
  async list(inboxId) {
    const r = await call(`/inboxes/${encodeURIComponent(inboxId)}/messages?limit=10`);
    const out: Mail[] = [];
    for (const m of (r.messages || []) as Record<string, unknown>[]) {
      const id = String(m.message_id);
      const full = await call(`/inboxes/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(id)}`);
      out.push({ id, from: String(full.from || m.from || ""), subject: String(full.subject || ""), text: String(full.text || full.extracted_text || ""), html: String(full.html || ""), at: String(full.timestamp || full.created_at || "") });
    }
    return out;
  },
};

/** Finds a one-time code. Prefers codes near words like "code"/"verification"; handles "ABC-123". */
export function findCode(mail: Pick<Mail, "subject" | "text" | "html">): string | null {
  const plain = `${mail.subject}\n${mail.text || mail.html.replace(/<[^>]+>/g, " ")}`;
  // "…copy the verification code into your browser: Ab12Cd34Ef" (Linear): whatever follows the colon,
  // 4 to 16 letters, digits or hyphens, case kept. Must contain a digit or be mixed/upper case letters,
  // so an ordinary word after a colon isn't taken for a code.
  const afterColon = plain.match(/(?:code|passcode|one[- ]time)[^:\n]{0,90}:\s*([A-Za-z0-9][A-Za-z0-9-]{2,14}[A-Za-z0-9])\b/i);
  if (afterColon && (/\d/.test(afterColon[1]) || /[A-Z]/.test(afterColon[1].slice(1)) || /^[A-Z]+$/.test(afterColon[1]))) return afterColon[1];
  const near = plain.match(/(?:code|verification|confirm|one[- ]time|OTP)[^\n]{0,60}?\b([A-Z0-9]{3}-[A-Z0-9]{3}|\d{4,8})\b/i);
  if (near) return near[1];
  const any = plain.match(/\b([A-Z0-9]{3}-[A-Z0-9]{3}|\d{6})\b/);
  return any ? any[1] : null;
}

/** Finds the verification or magic link, skipping unsubscribe, privacy and image links. */
export function findLink(mail: Pick<Mail, "text" | "html">, preferHost?: string): string | null {
  const links = [...`${mail.html} ${mail.text}`.matchAll(/https:\/\/[^\s"'<>)]+/g)].map((m) => m[0].replace(/&amp;/g, "&"));
  const useful = links.filter((l) => !/unsubscribe|privacy|terms|\.png|\.jpg|\.gif|preferences|help\./i.test(l));
  const scored = useful.map((l) => ({ l, s: (/verif|confirm|activate|magic|login|signin|auth|token=/i.test(l) ? 2 : 0) + (preferHost && l.includes(preferHost) ? 1 : 0) }));
  scored.sort((a, b) => b.s - a.s);
  return scored[0]?.l ?? null;
}

/** Polls the inbox until a matching new mail arrives. */
export async function waitForMail(inbox: Inbox, inboxId: string, opts: { from?: string; since: number; timeoutMs: number; pollMs?: number }): Promise<Mail | null> {
  const end = Date.now() + opts.timeoutMs;
  while (Date.now() < end) {
    const mails = await inbox.list(inboxId);
    const hit = mails.find((m) => (!opts.from || `${m.from} ${m.subject}`.toLowerCase().includes(opts.from.toLowerCase())) && (!m.at || Date.parse(m.at) >= opts.since - 60_000));
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 4000));
  }
  return null;
}
