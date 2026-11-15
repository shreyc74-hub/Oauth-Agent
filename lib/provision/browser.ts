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
  /** What the page shows: URL, title and the visible controls (for the recovery agent). */
  look(): Promise<{ url: string; title: string; elements: string[]; fields?: string; errors?: string[] }>;
  /** Anything on screen the agent must not or cannot get past by itself. */
  blocker(): Promise<Blocker | null>;
  /**
   * Is a step's goal actually reached on the page? act() does one action, so "Sign up with an email and
   * password" can report success after a single click. This asks the page instead of trusting act().
   */
  goalCheck?(goal: string): Promise<{ done: boolean; missing: string }>;
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

const goalSchema = z.object({
  done: z.boolean(),
  missing: z.string(),
});

const blockerSchema = z.object({
  blocker: z.enum(["none", "captcha", "phone", "device", "payment", "signin", "error"]),
  detail: z.string(),
});

/** Opens a new hosted browser, or reconnects to the run's existing one. */
export async function openBrowser(opts: { sessionId?: string; contextId?: string }): Promise<Driver> {
  const { Stagehand } = await import("@browserbasehq/stagehand");
  const model = process.env.STAGEHAND_MODEL || `anthropic/${process.env.GUIDE_MODEL || "claude-sonnet-5-5"}`;
  const make = (sessionId?: string) => new Stagehand({
    env: "BROWSERBASE",
    apiKey: process.env.BROWSERBASE_API_KEY,
    projectId: process.env.BROWSERBASE_PROJECT_ID,
    browserbaseSessionID: sessionId,
    keepAlive: true,
    browserbaseSessionCreateParams: sessionId ? undefined : {
      projectId: process.env.BROWSERBASE_PROJECT_ID,
      keepAlive: true,
      // Each live minute counts against the Browserbase plan, and a run waiting for a person keeps
      // its browser open. Expired sessions are replaced on the next step (cookies live in the context).
      timeout: Number(process.env.PROVISION_BROWSER_TIMEOUT_S || 900),
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
  });
  let sh = make(opts.sessionId);
  await sh.init();
  const sessionId = String(sh.browserbaseSessionID);
  const page = () => sh.context.activePage() ?? sh.context.pages()[0];
  // The connection to the hosted browser can drop mid-run (Stagehand then reports itself uninitialized).
  // Reconnect to the same session, so the page a person or the agent reached is kept, and retry once.
  const DEAD = /uninitiali[sz]ed|reading 'activePage'|Target (page, context or browser )?(has been )?closed|has been closed|not connected|WebSocket/i;
  /**
   * What code can see but the model's page snapshot can't: whether form fields are filled (never their
   * values) and whether a Cloudflare Turnstile check on the page is still unpassed.
   */
  const formState = async (): Promise<{ fields: string; turnstilePending: boolean; errors: string[] }> => {
    // Sign-up forms often live in an iframe (marketing form tools), so every frame is checked.
    const inFrame = () => {
      const vis = (e: Element) => !!((e as HTMLElement).offsetWidth || (e as HTMLElement).offsetHeight);
      const fields = [...document.querySelectorAll("input, textarea, select")]
        .filter((e) => vis(e) && !["hidden", "submit", "button", "radio"].includes((e as HTMLInputElement).type))
        .slice(0, 15)
        .map((e) => {
          const i = e as HTMLInputElement;
          const label = i.getAttribute("aria-label") || i.placeholder || i.name || i.id || i.type;
          const state = i.type === "checkbox" ? (i.checked ? "ticked" : "not ticked") : i.value ? "filled" : "empty";
          return `${label}: ${state}${i.required || i.getAttribute("aria-required") === "true" ? " (required)" : ""}`;
        });
      const disabled = [...document.querySelectorAll("button, input[type=submit]")].filter((e) => vis(e) && (e as HTMLButtonElement).disabled)
        .map((e) => `button "${((e as HTMLElement).innerText || (e as HTMLInputElement).value || "").trim().slice(0, 40)}" is disabled`);
      const ts = document.querySelector("input[name='cf-turnstile-response']") as HTMLInputElement | null;
      const errors = [...document.querySelectorAll("[role=alert], [aria-live=assertive], [class*=error i], [class*=invalid i], [id*=error i]")]
        .filter((e) => vis(e) && (e as HTMLElement).innerText && (e as HTMLElement).innerText.trim().length < 200)
        .map((e) => (e as HTMLElement).innerText.trim());
      const invalid = [...document.querySelectorAll("[aria-invalid=true]")].filter(vis).map((e) => `${(e as HTMLInputElement).getAttribute("aria-label") || (e as HTMLInputElement).placeholder || (e as HTMLInputElement).name || "a field"} is marked invalid`);
      return { fields, disabled, turnstilePending: Boolean(ts && !ts.value), errors: [...errors, ...invalid] };
    };
    try {
      const frames = (() => { try { return page().frames(); } catch { return []; } })();
      const all = await Promise.all((frames.length ? frames : [page().mainFrame()]).map((f) => f.evaluate(inFrame).catch(() => null)));
      const ok = all.filter(Boolean) as ReturnType<typeof inFrame>[];
      const uniq = (a: string[]) => a.filter((t, i) => t && a.indexOf(t) === i);
      return {
        fields: uniq(ok.flatMap((o) => [...o.fields, ...o.disabled])).slice(0, 20).join("; "),
        turnstilePending: ok.some((o) => o.turnstilePending),
        errors: uniq(ok.flatMap((o) => o.errors)).slice(0, 6),
      };
    } catch { return { fields: "", turnstilePending: false, errors: [] }; }
  };
  const guard = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
    try { return await fn(...a); }
    catch (e) {
      if (!DEAD.test(String((e as Error)?.message || e))) throw e;
      await sh.close().catch(() => undefined);
      sh = make(sessionId);
      await sh.init();
      return fn(...a);
    }
  };

  return {
    sessionId,
    liveUrl: (await liveViewUrl(sessionId)) || sh.browserbaseDebugURL,
    goto: guard(async (url: string) => { await page().goto(url); }),
    act: guard(async (instruction: string, variables?: Record<string, string>) => {
      // Typing a %value% into a field must replace what is there, not add to it (a second attempt once
      // produced "a@b.toa@b.to"). Find the field and empty it with code first.
      if (/\b(type|enter|fill|input|put)\b/i.test(instruction) && /%[a-z_]+%/i.test(instruction)) {
        const [field] = await sh.observe(`Find the text field that this instruction types into: "${instruction}". Return the input element itself.`).catch(() => []);
        if (field?.selector) await page().locator(field.selector).fill("").catch(() => undefined);
      }
      const r = await sh.act(instruction, { variables });
      return { ok: r.success, message: r.message };
    }),
    look: guard(async () => {
      const found = await sh.observe("List the visible headings, buttons, links, toggles and form fields on this page.");
      const fs = await formState();
      return { url: page().url(), title: await page().title().catch(() => ""), elements: found.slice(0, 40).map((a) => a.description), fields: fs.fields || undefined, errors: fs.errors.length ? fs.errors : undefined };
    }),
    blocker: guard(async (): Promise<Blocker | null> => {
      // Code first: an invisible Turnstile on a form that hasn't passed blocks submitting, with nothing
      // on screen for the model to see. Checked after the agent acted, so it is a real wall here.
      let fs = await formState();
      // Invisible Turnstile often passes by itself within a few seconds: give it that chance first.
      for (let i = 0; fs.turnstilePending && i < 3; i++) { await new Promise((r) => setTimeout(r, 2000)); fs = await formState(); }
      if (fs.turnstilePending) return { kind: "captcha", detail: "This form has a Cloudflare Turnstile check that hasn't passed for the automated browser, so the form won't submit. Submit it in the live browser (complete the check if one shows)." };
      const r = await sh.extract(
        "Is something on this page stopping an automated agent from continuing? Answer captcha for any CAPTCHA, 'verify you are human' or Turnstile check; phone for a phone number or SMS code request; device for approve-on-another-device or passkey prompts; payment for a card form; signin when the page asks to sign in; error for an error page. Otherwise answer none.",
        blockerSchema,
      );
      return r.blocker === "none" ? null : { kind: r.blocker, detail: r.detail };
    }),
    goalCheck: guard(async (goal: string) => {
      const fs = await formState();
      const r = await sh.extract(
        `A browser agent was given this task: "${goal}".${fs.fields ? ` Form fields as code sees them (the page text may not show typed values): ${fs.fields}.` : ""}${fs.errors.length ? ` Error messages on the page: ${fs.errors.join(" | ")}.` : ""} Look at the page now. Sign-up and set-up flows often spread one task over several screens: if this screen's part is done and the flow has moved on to its next screen (the next form, a "check your email" page, a code entry page, or the app itself), answer done=true; a later screen will be handled by a later step. Answer done=false if this screen still needs input, shows an error, or nothing was submitted, and say what is missing in a few words.`,
        goalSchema,
      );
      return { done: r.done, missing: r.missing };
    }),
    capture: guard(async (find: string, reveal?: string) => {
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
    }),
    url: () => { try { return page().url(); } catch { return ""; } },
    async detach() {
      // keepAlive: closing the client leaves the hosted browser running for the next step.
      await sh.close().catch(() => undefined);
    },
  };
}
