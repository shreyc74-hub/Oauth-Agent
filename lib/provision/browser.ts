// The browser the agent drives. Browserbase hosts it (so it works from Vercel and a person can take
// over through the live view), Stagehand turns plain-language steps into clicks.
//
// Rules this file enforces:
// - Secrets reach the page through Stagehand variables (%name%), which are not sent to the model.
// - Captured values are read with a fixed selector after the model has located the element, so the
//   model sees the masked field, not the revealed secret.
// - Browserbase's automatic captcha solving is switched off. Captchas go to a person.
import "../env";
import { z } from "zod";

export type Blocker = { kind: "captcha" | "phone" | "device" | "payment" | "signin" | "error"; detail: string };

export interface Driver {
  sessionId: string;
  liveUrl?: string;
  goto(url: string): Promise<void>;
  act(instruction: string, variables?: Record<string, string>): Promise<{ ok: boolean; message: string }>;
  /** Anything on screen the agent must not or cannot get past by itself. */
  blocker(): Promise<Blocker | null>;
  /** Locates `find`, optionally clicks `reveal`, then reads the value without the model seeing it. */
  capture(find: string, reveal?: string): Promise<string>;
  url(): string;
  /** Ends this server's connection; the hosted browser stays alive for the next step or a person. */
  detach(): Promise<void>;
}

const BB = "https://api.browserbase.com/v1";

export function browserConfigured(): boolean {
  return Boolean(process.env.BROWSERBASE_API_KEY && process.env.BROWSERBASE_PROJECT_ID);
}

/** A per-provider browser context keeps cookies between runs, so a signed-in console stays signed in. */
export async function createContext(): Promise<string> {
  const res = await fetch(`${BB}/contexts`, {
    method: "POST",
    headers: { "x-bb-api-key": String(process.env.BROWSERBASE_API_KEY), "content-type": "application/json" },
    body: JSON.stringify({ projectId: process.env.BROWSERBASE_PROJECT_ID }),
  });
  if (!res.ok) throw new Error(`Browserbase context ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return String(((await res.json()) as { id: string }).id);
}

/** Lets Browserbase shut the hosted browser down. */
export async function releaseSession(sessionId: string): Promise<void> {
  await fetch(`${BB}/sessions/${sessionId}`, {
    method: "POST",
    headers: { "x-bb-api-key": String(process.env.BROWSERBASE_API_KEY), "content-type": "application/json" },
    body: JSON.stringify({ projectId: process.env.BROWSERBASE_PROJECT_ID, status: "REQUEST_RELEASE" }),
  }).catch(() => undefined);
}

async function liveViewUrl(sessionId: string): Promise<string | undefined> {
  const res = await fetch(`${BB}/sessions/${sessionId}/debug`, { headers: { "x-bb-api-key": String(process.env.BROWSERBASE_API_KEY) } }).catch(() => null);
  if (!res?.ok) return undefined;
  const j = (await res.json()) as { debuggerFullscreenUrl?: string };
  return j.debuggerFullscreenUrl;
}

const blockerSchema = z.object({
  blocker: z.enum(["none", "captcha", "phone", "device", "payment", "signin", "error"]),
  detail: z.string(),
});

/** Opens a new hosted browser, or reconnects to the run's existing one. */
export async function openBrowser(opts: { sessionId?: string; contextId?: string }): Promise<Driver> {
  const { Stagehand } = await import("@browserbasehq/stagehand");
  const model = process.env.STAGEHAND_MODEL || `anthropic/${process.env.GUIDE_MODEL || "claude-sonnet-5-5"}`;
  const sh = new Stagehand({
    env: "BROWSERBASE",
    apiKey: process.env.BROWSERBASE_API_KEY,
    projectId: process.env.BROWSERBASE_PROJECT_ID,
    browserbaseSessionID: opts.sessionId,
    keepAlive: true,
    browserbaseSessionCreateParams: opts.sessionId ? undefined : {
      projectId: process.env.BROWSERBASE_PROJECT_ID,
      keepAlive: true,
      timeout: 3600,
      browserSettings: {
        solveCaptchas: false,
        recordSession: true,
        viewport: { width: 1280, height: 800 },
        ...(opts.contextId ? { context: { id: opts.contextId, persist: true } } : {}),
      },
    },
    model: { modelName: model, apiKey: process.env.ANTHROPIC_API_KEY },
    verbose: 0,
    disablePino: true,
  } as ConstructorParameters<typeof Stagehand>[0]);
  await sh.init();
  const sessionId = String(sh.browserbaseSessionID);
  const page = () => sh.context.activePage() ?? sh.context.pages()[0];

  return {
    sessionId,
    liveUrl: (await liveViewUrl(sessionId)) || sh.browserbaseDebugURL,
    async goto(url) { await page().goto(url); },
    async act(instruction, variables) {
      const r = await sh.act(instruction, { variables });
      return { ok: r.success, message: r.message };
    },
    async blocker() {
      const r = await sh.extract(
        "Is something on this page stopping an automated agent from continuing? Answer captcha for any CAPTCHA, 'verify you are human' or Turnstile check; phone for a phone number or SMS code request; device for approve-on-another-device or passkey prompts; payment for a card form; signin when the page asks to sign in; error for an error page. Otherwise answer none.",
        blockerSchema,
      );
      return r.blocker === "none" ? null : { kind: r.blocker, detail: r.detail };
    },
    async capture(find, reveal) {
      // Locate first (the field is still masked), then reveal, then read with a fixed selector.
      const [target] = await sh.observe(`Find ${find}. Return the element that contains or holds the value itself.`);
      if (!target) throw new Error(`Could not find ${find}.`);
      if (reveal) {
        const [btn] = await sh.observe(`Find ${reveal}.`);
        if (btn) await sh.act(btn);
      }
      const loc = page().locator(target.selector);
      let value = (await loc.inputValue().catch(() => "")) || (await loc.innerText().catch(() => "")) || (await loc.textContent().catch(() => ""));
      value = value.trim();
      if (!value || /^[•*·.\s]+$/.test(value)) throw new Error(`The value for ${find} is empty or still masked.`);
      return value;
    },
    url: () => page().url(),
    async detach() {
      // keepAlive: closing the client leaves the hosted browser running for the next step.
      await sh.close().catch(() => undefined);
    },
  };
}
