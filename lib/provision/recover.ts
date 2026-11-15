// The recovery agent. The playbook is a fixed workflow; when one of its browser or capture steps
// fails (the console changed, a button moved, a dialog got in the way), this agent gets the step's
// goal and a few tools and tries to reach that goal itself before a person is asked.
//
// Workflow where it must be safe, agent where the world is uncertain. The agent decides what to do;
// code decides what it is allowed to do:
// - It never receives a secret. Values go page -> vault through the capture tool, and anything it
//   reads back from the page is redacted against the secrets seen in this run.
// - In human-in-the-loop mode, any create, submit or consent action stops for approval.
// - Captchas, phone checks and payment are walls: it must stop, not work around them.
// - It stays on the provider's own sites.
// - It has a budget (actions and time), then it hands over with a note of what it tried.
import "../env";
import type { Driver, Blocker } from "./browser";
import type { Mode } from "./types";

export type Block = { type: string; [k: string]: unknown };
export type Msg = { role: "user" | "assistant"; content: string | Block[] };
export type Tool = { name: string; description: string; input_schema: Record<string, unknown> };
/** Something that picks the next tool calls: Claude in production, a script in tests. */
export type Brain = (system: string, messages: Msg[], tools: Tool[]) => Promise<Block[]>;

export type RecoveryResult =
  | { outcome: "recovered"; summary: string; fix?: string; tried: string[] }
  | { outcome: "wall"; blocker: Blocker; tried: string[] }
  | { outcome: "needs_approval"; instruction: string; tried: string[] }
  | { outcome: "gave_up"; reason: string; tried: string[] };

export interface RecoveryEnv {
  driver: Driver;
  brain: Brain;
  mode: Mode;
  app: string;
  step: { id: string; title: string; kind: "browser" | "capture"; instruction?: string; url?: string; find?: string; into?: string };
  error: string;
  allowedHosts: string[];
  /** Labels the capture tool may write (the playbook's own capture targets). */
  captureLabels: string[];
  /** %names% the agent may use in act; values are filled in by code. */
  variableNames: string[];
  /** Write actions a person already approved for this step. */
  approved: string[];
  hasInbox: boolean;
  resolveVars: (text: string, extra: Record<string, string>) => Promise<Record<string, string>>;
  storeValue: (label: string, value: string) => Promise<void>;
  readInboxCode: () => Promise<string | null>;
  /** The sign-in or verification link from the latest email. Opened by code; the model never sees it. */
  readInboxLink?: () => Promise<string | null>;
  redact: (text: string) => string;
  trace: (text: string) => void;
  maxActions?: number;
  deadline: number;
}

export const WRITE_RE = /\b(create|submit|save|authori[sz]e|allow|accept|agree|install|confirm|delete|remove|sign ?up|register|publish|connect|generate|approve)\b/i;
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

export function hostAllowed(url: string, hosts: string[]): boolean {
  try {
    const h = new URL(url).hostname;
    return hosts.some((a) => h === a || h.endsWith(`.${a}`));
  } catch { return url.startsWith("about:"); }
}

export const SYSTEM = `You are the recovery agent inside a provisioning workflow that creates OAuth test apps.
A scripted step just failed. Your job: reach that step's goal in the hosted browser, then call done.

How to work:
- Start with look. Act one small step at a time, then look again to check the result.
- look also reports which fields are filled (never their values) and any error messages. Read them before acting: if a field is already filled, don't type into it again unless an error says it is wrong; if an error shows (for example "Please enter a valid email address"), fix that field first, because a submit button usually stays disabled until it is fixed. Typing replaces a field's text.
- Use %placeholders% for any value listed under "Values you can type". You never see their values.
- To read a value off the page (a client ID, a client secret, an ID), use capture. It goes straight to the vault and you will only be told it was stored. Never try to read a secret with look.
- If the page shows a captcha, a "verify you are human" check, a phone or SMS request, a device or passkey prompt, or a payment form, call ask_human. Do not try to get around it.
- Set is_write true for anything that creates, submits, saves, installs, accepts terms or grants consent.
- Stay on the provider's sites.
- When the goal is met, call done with a one-line summary and, if the console differs from the step's instruction, a playbook_fix: the instruction that would have worked.
- If you are stuck after a few tries, call ask_human with what a person should do.`;

export function toolsFor(env: Pick<RecoveryEnv, "captureLabels" | "hasInbox" | "readInboxLink">): Tool[] {
  const tools: Tool[] = [
    { name: "look", description: "Describe the current page: URL, title and the visible headings, buttons, links and fields.", input_schema: { type: "object", properties: {} } },
    { name: "act", description: "Do one browser action described in plain English (click, type, choose, scroll). Optionally open a URL first. Use %placeholders% for values.", input_schema: { type: "object", properties: { instruction: { type: "string" }, url: { type: "string", description: "Optional URL to open before acting. Must be on the provider's sites." }, is_write: { type: "boolean", description: "True if this creates, submits, saves, installs, accepts or consents." } }, required: ["instruction", "is_write"] } },
    { name: "capture", description: "Read a value off the page straight into the vault. You are told only that it was stored.", input_schema: { type: "object", properties: { label: { type: "string", enum: env.captureLabels }, find: { type: "string", description: "Plain-English description of the element holding the value." }, reveal: { type: "string", description: "Optional button that reveals a masked value." } }, required: ["label", "find"] } },
    { name: "ask_human", description: "Stop and hand over to a person, saying what they should do.", input_schema: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] } },
    { name: "done", description: "The goal is met. Summarise, and suggest a playbook fix if the console differs from the instruction.", input_schema: { type: "object", properties: { summary: { type: "string" }, playbook_fix: { type: "string" } }, required: ["summary"] } },
  ];
  if (env.hasInbox) tools.splice(3, 0, { name: "read_inbox_code", description: "Get the latest code from the agent's email inbox. It becomes %code% for act; you won't see it.", input_schema: { type: "object", properties: {} } });
  if (env.hasInbox && env.readInboxLink) tools.splice(4, 0, { name: "open_inbox_link", description: "Open the sign-in or verification link from the latest email in the agent's inbox, in this browser. You won't see the link itself.", input_schema: { type: "object", properties: {} } });
  return tools;
}

export function briefFor(env: RecoveryEnv): string {
  const s = env.step;
  const goal = s.kind === "capture"
    ? `Get ${s.find} into the vault with capture label "${s.into}".`
    : `Do what this instruction intended: ${s.instruction || s.title}`;
  return [
    `App: ${env.app}. Step: ${s.title}.`,
    `Goal: ${goal}`,
    s.instruction ? `Original instruction: ${s.instruction}` : "",
    s.url ? `Step URL: ${s.url}` : "",
    `What went wrong: ${env.error}`,
    `Values you can type: ${env.variableNames.map((n) => `%${n}%`).join(", ") || "none"}`,
    `Allowed sites: ${env.allowedHosts.join(", ")}`,
    env.approved.length ? `A person already approved these actions: ${env.approved.join(" | ")}` : "",
    env.mode === "human" ? "Mode: human in the loop. Any write you attempt that is not in the approved list stops for approval." : "Mode: full automation.",
  ].filter(Boolean).join("\n");
}

/** Runs the agent loop until the goal is met, a wall or approval stops it, or the budget runs out. */
export async function recover(env: RecoveryEnv): Promise<RecoveryResult> {
  const tools = toolsFor(env);
  const messages: Msg[] = [{ role: "user", content: briefFor(env) }];
  const tried: string[] = [];
  const extra: Record<string, string> = {};
  const max = env.maxActions ?? 8;
  let actions = 0;

  while (actions < max && Date.now() < env.deadline) {
    const blocks = await env.brain(SYSTEM, messages, tools);
    messages.push({ role: "assistant", content: blocks });
    const thought = blocks.filter((b) => b.type === "text").map((b) => String(b.text)).join(" ").trim();
    if (thought) env.trace(`thinks: ${env.redact(thought).slice(0, 240)}`);
    const calls = blocks.filter((b) => b.type === "tool_use") as { type: string; id: string; name: string; input: Record<string, unknown> }[];
    if (!calls.length) return { outcome: "gave_up", reason: "the agent stopped without finishing", tried };

    const results: Block[] = [];
    for (const c of calls) {
      actions++;
      const input = c.input || {};
      let out = "";
      let isError = false;
      try {
        switch (c.name) {
          case "look": {
            const l = await env.driver.look();
            out = env.redact(JSON.stringify(l)).slice(0, 3500);
            env.trace(`look: ${l.title || l.url}`);
            break;
          }
          case "act": {
            const instruction = String(input.instruction || "").slice(0, 600);
            const url = input.url ? String(input.url) : "";
            const write = Boolean(input.is_write) || WRITE_RE.test(instruction);
            if (url && !hostAllowed(url, env.allowedHosts)) { out = `Refused: ${url} is not on the provider's sites.`; isError = true; break; }
            if (write && env.mode === "human" && !env.approved.some((a) => norm(a) === norm(instruction))) {
              env.trace(`asks approval: ${instruction}`);
              return { outcome: "needs_approval", instruction, tried };
            }
            const before = env.driver.url();
            if (url) await env.driver.goto(url);
            const r = await env.driver.act(instruction, await env.resolveVars(instruction, extra));
            tried.push(instruction);
            env.trace(`act${write ? " (write)" : ""}: ${instruction}${r.ok ? "" : ` -> failed: ${r.message.slice(0, 100)}`}`);
            if (!hostAllowed(env.driver.url(), env.allowedHosts)) {
              await env.driver.goto(before);
              out = "That left the provider's sites, so the browser went back."; isError = true; break;
            }
            const b = await env.driver.blocker();
            if (b && b.kind !== "signin") return { outcome: "wall", blocker: b, tried };
            out = r.ok ? `Done. Now on ${env.driver.url()}.` : `Failed: ${env.redact(r.message).slice(0, 200)}`;
            isError = !r.ok;
            break;
          }
          case "capture": {
            const label = String(input.label || "");
            if (!env.captureLabels.includes(label)) { out = `Refused: ${label} is not a value this step may capture.`; isError = true; break; }
            const value = await env.driver.capture(String(input.find || ""), input.reveal ? String(input.reveal) : undefined);
            await env.storeValue(label, value);
            tried.push(`capture ${label}`);
            env.trace(`capture: ${label} stored in the vault`);
            out = `Stored ${label} in the vault.`;
            break;
          }
          case "read_inbox_code": {
            const code = await env.readInboxCode();
            if (!code) { out = "No code in the inbox yet."; isError = true; break; }
            extra.code = code;
            env.trace("read_inbox_code: code saved as %code%");
            out = "Code saved. Use %code% in act.";
            break;
          }
          case "open_inbox_link": {
            const link = env.readInboxLink ? await env.readInboxLink() : null;
            if (!link) { out = "No sign-in link in the latest email."; isError = true; break; }
            if (!hostAllowed(link, env.allowedHosts)) { out = "The email's link is not on the provider's sites, so it was not opened."; isError = true; break; }
            await env.driver.goto(link);
            env.trace("open_inbox_link: opened the link from the email");
            out = `Opened the link from the email. Now on ${env.redact(env.driver.url().split("?")[0])}.`;
            break;
          }
          case "ask_human":
            env.trace(`ask_human: ${String(input.reason || "")}`);
            return { outcome: "gave_up", reason: env.redact(String(input.reason || "the agent asked for help")).slice(0, 400), tried };
          case "done":
            env.trace(`done: ${String(input.summary || "")}`);
            return { outcome: "recovered", summary: env.redact(String(input.summary || "")).slice(0, 300), fix: input.playbook_fix ? env.redact(String(input.playbook_fix)).slice(0, 400) : undefined, tried };
          default:
            out = `Unknown tool ${c.name}.`; isError = true;
        }
      } catch (e) {
        out = `Error: ${env.redact((e as Error).message).slice(0, 200)}`;
        isError = true;
        env.trace(`${c.name} failed: ${out}`);
      }
      results.push({ type: "tool_result", tool_use_id: c.id, content: out, ...(isError ? { is_error: true } : {}) });
    }
    messages.push({ role: "user", content: results });
  }
  return { outcome: "gave_up", reason: `used its budget (${max} actions or 2 minutes) without finishing`, tried };
}

// ---------- Brains ----------

/** Claude through the Messages API (non-streaming; recovery turns are short). */
export const claudeBrain: Brain = async (system, messages, tools) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw Object.assign(new Error("ANTHROPIC_API_KEY is not set"), { name: "ConfigError" });
  const res = await fetch(`${process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com"}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: process.env.RECOVERY_MODEL || process.env.GUIDE_MODEL || "claude-sonnet-5-5", max_tokens: 1500, system, tools, messages }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { content: Block[] }).content;
};

/**
 * Scripted brain for demo mode and tests. PROVISION_MOCK_RECOVERY picks the behaviour:
 * ok (default): look, retry differently or capture, done with a fix. giveup: look, ask_human.
 * loop: keeps scrolling until the budget runs out. write: tries a create action (needs approval in HITL).
 */
export const mockBrain: Brain = async (_system, messages) => {
  const brief = String(messages[0].content);
  const turn = messages.filter((m) => m.role === "assistant").length;
  const last = messages[messages.length - 1];
  const lastFailed = Array.isArray(last.content) && last.content.some((b) => b.is_error);
  const id = `t${turn}`;
  const thoughts: Record<string, string> = { look: "Checking what the page shows now.", act: "Trying another route to the same goal.", capture: "Reading the value straight into the vault.", ask_human: "I can't finish this safely myself.", done: "Goal reached." };
  const call = (name: string, input: Record<string, unknown> = {}): Block[] => [{ type: "text", text: thoughts[name] || name }, { type: "tool_use", id, name, input }];
  const mode = process.env.PROVISION_MOCK_RECOVERY || "ok";
  if (turn === 0) return call("look");
  if (mode === "giveup") return call("ask_human", { reason: "The page layout doesn't match anything I recognise. Please finish this step in the live browser." });
  if (mode === "loop") return call("act", { instruction: "Scroll down to see more of the page", is_write: false });
  if (lastFailed) return call("ask_human", { reason: "My retry failed too. Please finish this step in the live browser." });
  const capture = brief.match(/capture label "([^"]+)"/);
  if (turn === 1) {
    if (mode === "write") return call("act", { instruction: "Click the button labelled Create app", is_write: true });
    if (capture) return call("capture", { label: capture[1], find: "the value in the credentials panel", reveal: "the eye icon next to it" });
    const original = (brief.match(/Original instruction: (.*)/) || [])[1] || "";
    return call("act", { instruction: `Open the menu in the left sidebar, then: ${original}`, is_write: false });
  }
  return call("done", { summary: "Reached the goal by another route.", playbook_fix: "The control has moved into the left sidebar menu; open that menu first." });
};
