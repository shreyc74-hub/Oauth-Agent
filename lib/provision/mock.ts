// Offline stand-ins for the browser, the inbox and the provider APIs. PROVISION_MOCK=1 (or AGENT_MOCK=1)
// runs the whole flow, handoffs and approvals included, without any accounts. Used by the tests and
// for demoing the UI. PROVISION_MOCK_BLOCKER=captcha makes the first sign-up step hit a captcha.
import { randomBytes } from "node:crypto";
import type { Driver, Blocker } from "./browser";
import type { Inbox, Mail } from "./inbox";
import type { Http } from "./verify";

export const mockEnabled = () => process.env.PROVISION_MOCK === "1" || process.env.AGENT_MOCK === "1";

const sessions = new Map<string, { url: string; pendingState?: string; redirect?: string; blockerShown?: boolean }>();

/**
 * `mockFail` simulates a console that changed: browser steps whose instruction starts with one of the
 * listed step titles' words fail until the recovery agent takes another route (via the sidebar).
 */
export async function mockBrowser(opts: { sessionId?: string; mockFail?: string }): Promise<Driver> {
  const id = opts.sessionId || `mock-session-${randomBytes(4).toString("hex")}`;
  if (!sessions.has(id)) sessions.set(id, { url: "about:blank" });
  const s = sessions.get(id)!;
  let lastInstruction = "";
  return {
    sessionId: id,
    liveUrl: `about:blank#live-view-${id}`,
    async goto(url) {
      s.url = url;
      try {
        const u = new URL(url);
        if (u.searchParams.get("state")) { s.pendingState = u.searchParams.get("state")!; s.redirect = u.searchParams.get("redirect_uri") || ""; }
      } catch { /* not a URL */ }
    },
    async act(instruction) {
      lastInstruction = instruction;
      if (/authorize|allow|connect app|approve/i.test(instruction) && s.pendingState && s.redirect) {
        s.url = `${s.redirect}?code=mock_code_${randomBytes(3).toString("hex")}&state=${s.pendingState}`;
      }
      if (/FAIL_ACT/.test(instruction)) return { ok: false, message: "Element not found" };
      if (opts.mockFail && instruction.startsWith(opts.mockFail) && !/left sidebar/.test(instruction)) return { ok: false, message: "No element matches: the console layout changed" };
      return { ok: true, message: "done" };
    },
    async look() {
      return { url: s.url, title: "Developer settings", elements: ["Left sidebar menu", "Applications list", "Button: New application", "Credentials panel (masked)"] };
    },
    async blocker(): Promise<Blocker | null> {
      const want = process.env.PROVISION_MOCK_BLOCKER;
      if (want && !s.blockerShown && /email/i.test(lastInstruction)) { s.blockerShown = true; return { kind: want as Blocker["kind"], detail: `A ${want} check is showing.` }; }
      return null;
    },
    async capture(find) {
      if (/secret|token/i.test(find)) return `mock_secret_${randomBytes(12).toString("hex")}`;
      if (/id/i.test(find)) return `mock_client_${randomBytes(6).toString("hex")}`;
      return `mock_${randomBytes(4).toString("hex")}`;
    },
    url: () => s.url,
    async detach() { /* nothing */ },
  };
}

export const mockInbox: Inbox = {
  async create(username) { return { inboxId: `${username}@agentmail.to`, email: `${username}@agentmail.to` }; },
  async list(inboxId): Promise<Mail[]> {
    const provider = inboxId.split("-")[0];
    return [{ id: "m1", from: `no-reply@${provider}.example`, subject: "Your verification code", text: "Your verification code is 482913. Or click https://provider.example/verify?token=abc", html: "", at: new Date().toISOString() }];
  },
};

/** Answers token, identity and Slack manifest calls. Refresh tokens rotate like the real thing. */
export const mockHttp: Http = async (url, init) => {
  const body = String(init?.body || "");
  const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
  if (url.includes("tooling.tokens.rotate")) return json({ ok: true, token: `xoxe.xoxp-mock-${randomBytes(4).toString("hex")}`, refresh_token: `xoxe-1-mock-${randomBytes(4).toString("hex")}` });
  if (url.includes("apps.manifest.create")) return json({ ok: true, app_id: "A0MOCK", credentials: { client_id: "1234.5678", client_secret: `mock_secret_${randomBytes(8).toString("hex")}`, signing_secret: "mock_sign", verification_token: "mock_ver" }, oauth_authorize_url: "https://slack.com/oauth/v2/authorize?client_id=1234.5678" });
  if (/token|oauth\.v2\.access/.test(url) && body.includes("grant_type")) {
    return json({ ok: true, access_token: `mock_access_${randomBytes(6).toString("hex")}`, refresh_token: `mock_refresh_${randomBytes(6).toString("hex")}`, expires_in: 3600 });
  }
  return json({ ok: true, team: "Mock Sandbox", portalId: 4200123, data: { viewer: { id: "u1", name: "Mock Sandbox", email: "agent@agentmail.to" } }, id: "u1" });
};
