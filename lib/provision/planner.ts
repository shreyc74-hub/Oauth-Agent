// Picks the playbook for an app. Hand-written playbooks for the demo providers; for any other app the
// planner turns that app's readiness guide (the first assignment's output) into a playbook with Claude.
// The guide is the agent's map: no guide, no plan. Generated playbooks are marked "unverified".
import type { Guide } from "../schema";
import type { Progress, SandboxCheck } from "./types";
import type { Mode, Playbook, Step } from "./types";
import { linear } from "./playbooks/linear";
import { slack } from "./playbooks/slack";
import { hubspot } from "./playbooks/hubspot";
import { runClaude, RESOLVE_MODEL, jsonFromModel } from "../agent/claude";

export const PLAYBOOKS: Record<string, Playbook> = { linear, slack, hubspot };

const KINDS = new Set(["identity", "browser", "capture", "email", "totp", "api", "human", "verify", "golive"]);

/** Structural checks for any playbook, hand-written or generated. Returns a list of problems. */
const HTTPS = /^https:\/\/[^/]+\.[^/]+/;

export function validatePlaybook(p: Playbook): string[] {
  const errs: string[] = [];
  if (!p.slug || !p.name) errs.push("slug and name are required");
  const key = p.credential === "api_key";
  if (key) {
    if (!p.apiKey?.header) errs.push("api_key plan needs apiKey.header");
    if (!HTTPS.test(String(p.apiKey?.testUrl || "")) || /[{}<>%]/.test(String(p.apiKey?.testUrl || ""))) errs.push(`api_key test call is not a plain https URL: ${p.apiKey?.testUrl}`);
  } else {
    for (const u of [p.oauth?.authorizeUrl, p.oauth?.tokenUrl, p.oauth?.whoami?.url]) {
      if (!HTTPS.test(String(u || ""))) errs.push(`not an https URL: ${u}`);
    }
    if (!p.oauth?.scopes?.length) errs.push("no scopes");
  }
  for (const mode of ["human", "auto"] as Mode[]) {
    const steps = p.steps?.[mode] || [];
    const ids = new Set<string>();
    for (const s of steps) {
      if (!KINDS.has(s.kind)) errs.push(`${mode}: unknown step kind ${s.kind}`);
      if (ids.has(s.id)) errs.push(`${mode}: duplicate step id ${s.id}`);
      ids.add(s.id);
      if (s.kind === "browser" && /client.?secret|password|token/i.test(s.instruction || "") && !(s.secrets || []).length) {
        errs.push(`${mode}: step ${s.id} mentions a secret but does not use a %variable%`);
      }
    }
    const captures = steps.filter((s): s is Extract<Step, { kind: "capture" }> => s.kind === "capture").map((s) => s.into);
    if (key) { if (!captures.includes("api_key")) errs.push(`${mode}: must capture api_key`); }
    else if (p.strategy === "dcr") { if (!steps.some((s) => s.kind === "api" && s.handler === "dcrRegister")) errs.push(`${mode}: a dcr plan needs the dcrRegister api step`); }
    else if (p.strategy !== "api" && !(captures.includes("client_id") && captures.includes("client_secret"))) errs.push(`${mode}: must capture client_id and client_secret`);
    if (!steps.some((s) => s.kind === "verify")) errs.push(`${mode}: no verify step`);
    if (mode === "human" && steps.some((s) => s.kind === "identity")) errs.push("human mode must not create an agent identity");
  }
  return errs;
}

const PLAN_SYSTEM = `You turn an OAuth readiness guide into a provisioning playbook for a browser agent.
Return ONLY one JSON object matching this TypeScript type, no prose:

type Step =
 | {kind:"identity",id,title}
 | {kind:"browser",id,title,url?,instruction?,secrets?:string[],write?:boolean}
 | {kind:"capture",id,title,find,reveal?,into,secret:boolean}
 | {kind:"email",id,title,from?,extract:"code"|"link",then?}
 | {kind:"human",id,title,reason}
 | {kind:"verify",id,title}
 | {kind:"golive",id,title}
type Playbook = {slug,name,strategy:"browser"|"human",evidence:"unverified",
 sandbox:{kind,note}, oauth:{authorizeUrl,tokenUrl,whoami:{url,method?,body?,pick},scopes:string[],scopeSeparator?,clientAuth?:"body"|"basic",consentInstruction,refresh:"yes"|"no"|"if-enabled"},
 steps:{human:Step[],auto:Step[]}, goLive:{needed:boolean,summary,humanWork:string[]}, notes:string[]}

Rules:
- Use only facts from the guide. If the guide does not give the token endpoint or an identity endpoint, use the provider's documented ones you are confident about and add a note saying they are unverified.
- Browser instructions are plain English for one screen at a time. Put values in %placeholders%: %app_name%, %dev_name%, %dev_url%, %redirect_uri%, %workspace_name%, %email%, %password%, %code%.
- Every browser step lists each %placeholder% its instruction uses in "secrets" (e.g. "Sign up with %email% and %password%." has secrets ["email","password"]). Any step that types a password, token or secret must type it through a %placeholder%.
- Never put a secret value in an instruction. Secrets are captured with "capture" steps (into "client_id" secret:false, "client_secret" secret:true).
- Mark any step that creates, submits, accepts terms or installs as write:true.
- human mode starts with a human step "Sign in" and has no identity/email steps. auto mode starts with identity, then sign-up via %email%, email verification, then the same creation steps.
- Steps the guide says need a person (legal terms, business verification, payment) become human steps.
- Setup map: if relation is "separate", the sandbox is its own account or environment (a Slack workspace, a HubSpot test account, a Zoho Invoice organization). Both modes then include steps that create or open that sandbox (its name and URL from the map) before the OAuth app is authorized, and the consentInstruction picks that sandbox when the consent screen asks which account, workspace or organization to use. Put its name in sandbox.kind and how to create it in sandbox.note, and set sandbox.relation. If relation is "same", the account created at sign-up is the sandbox.
- Provision "API KEY": set "credential":"api_key" and "apiKey":{"header":"the header the key goes in, e.g. Authorization or X-API-Key","prefix":"e.g. Bearer, or omit","testUrl":"a real read-only GET endpoint with no placeholders that needs the key","pick":"optional JSON path in its answer"}. Steps: (human: Sign in) or (auto: identity, sign-up, email verification), then open the account's API key settings, create a key named %app_name% (write:true), and a capture step into "api_key" with secret:true. No OAuth app, no client_id/client_secret captures; "oauth" may be omitted.
- Provision "OAuth app through Dynamic Client Registration": strategy "dcr". The app is NOT created in a console: after the sign-in or sign-up steps, add {"kind":"api","id":"dcr-register","title":"Register the OAuth app (Dynamic Client Registration)","handler":"dcrRegister","write":true}. No client_id/client_secret captures. The account is still needed, to approve consent during verify.
- Both modes end with verify then golive.
- Scopes: the smallest set from the guide's minimal sets.`;

/** Builds a playbook for an app that has a guide but no hand-written playbook. */
/** What the research decided the plan must provision, and how. */
export interface PlanTarget { credential: "oauth" | "api_key"; dcr?: boolean; keyWhere?: string }

export async function planFromGuide(guide: Guide, setup?: SandboxCheck, progress: Progress = () => undefined, target: PlanTarget = { credential: "oauth" }): Promise<Playbook> {
  const brief = {
    name: guide.name, website: guide.website, verdict: guide.verdict,
    steps: guide.steps, prerequisites: guide.prerequisites, appTypes: guide.appTypes?.items,
    scopes: guide.scopes?.minimalSets, approval: guide.approval, tokens: (guide as unknown as Record<string, unknown>).tokens,
  };
  // The sandbox check's map: where the app is made, and the separate environment it is tested in.
  const map = setup?.parts ? { relation: setup.relation, parts: setup.parts.map((p) => ({ role: p.role, name: p.name, url: p.url, expires: p.expires })) } : undefined;
  const goal = target.credential === "api_key"
    ? `\nProvision: an API KEY, not an OAuth app (OAuth is not self-serve for this vendor).${target.keyWhere ? ` Where keys are created: ${target.keyWhere}.` : ""}`
    : target.dcr ? "\nProvision: an OAuth app through Dynamic Client Registration (strategy \"dcr\")." : "\nProvision: an OAuth app.";
  const ask = `Guide for ${guide.name} (slug ${guide.slug}):\n${JSON.stringify(brief)}${map ? `\nSetup map (checked against the vendor's pages):\n${JSON.stringify(map)}` : ""}${goal}`;
  const parse = async (text: string): Promise<Playbook> => {
    const p = await jsonFromModel<Playbook>(text);
    p.slug = guide.slug; p.name = guide.name; p.evidence = "unverified";
    if (target.credential === "api_key") { p.credential = "api_key"; p.oauth = p.oauth || NO_OAUTH; }
    if (target.dcr && target.credential === "oauth") p.strategy = "dcr";
    return fillSecretLists(p);
  };
  const first = await runClaude({ model: RESOLVE_MODEL, system: PLAN_SYSTEM, maxTokens: 6000, messages: [{ role: "user", content: ask }] });
  let p = await parse(first);
  let errs = validatePlaybook(p);
  if (errs.length) {
    progress({ id: "plan:fix", label: "The plan failed safety checks; Claude is asked to fix it", state: "start", detail: errs.slice(0, 3).join("; ") });
    // One correction round: the planner sees exactly which checks failed and returns a fixed plan.
    const second = await runClaude({
      model: RESOLVE_MODEL, system: PLAN_SYSTEM, maxTokens: 6000,
      messages: [
        { role: "user", content: ask },
        { role: "assistant", content: first },
        { role: "user", content: `That plan failed these checks:\n- ${errs.join("\n- ")}\nReturn the whole corrected plan as JSON only.` },
      ],
    });
    p = await parse(second);
    errs = validatePlaybook(p);
    progress({ id: "plan:fix", label: "The plan failed safety checks; Claude is asked to fix it", state: errs.length ? "fail" : "done", detail: errs.length ? errs.slice(0, 3).join("; ") : "corrected plan passes the checks" });
  }
  if (errs.length) throw new Error(`The agent couldn't write a safe plan for ${guide.name} (checked twice): ${errs.slice(0, 4).join("; ")}`);
  return p;
}

/** Browser steps must list the %placeholders% they type. Fills in a list the planner forgot. */
export function fillSecretLists(p: Playbook): Playbook {
  for (const mode of ["human", "auto"] as Mode[]) {
    for (const s of p.steps?.[mode] || []) {
      if (s.kind !== "browser" || !s.instruction) continue;
      const used = [...s.instruction.matchAll(/%([a-z_][a-z0-9_]*)%/gi)].map((m) => m[1]);
      if (used.length) s.secrets = [...new Set([...(s.secrets || []), ...used])];
    }
  }
  return p;
}

const NO_OAUTH: Playbook["oauth"] = { authorizeUrl: "", tokenUrl: "", whoami: { url: "", pick: "" }, scopes: [], consentInstruction: "", refresh: "no" };

/** Offline plan used in mock mode and tests: generic console steps from the guide. */
export function mockPlanFromGuide(guide: Guide, target: PlanTarget = { credential: "oauth" }): Playbook {
  const create: Step[] = target.credential === "api_key" ? [
    { kind: "browser", id: "open-keys", title: "Open the API key settings", url: `https://${guide.website}`, instruction: "Open the account's API key settings." },
    { kind: "browser", id: "create-key", title: "Create the API key", instruction: "Create an API key named %app_name%.", secrets: ["app_name"], write: true },
    { kind: "capture", id: "api-key", title: "Read the API key into the vault", find: "the new API key", into: "api_key", secret: true },
    { kind: "verify", id: "verify", title: "Verify the API key" },
    { kind: "golive", id: "golive", title: "Check what going live needs" },
  ] : target.dcr ? [
    { kind: "api", id: "dcr-register", title: "Register the OAuth app (Dynamic Client Registration)", handler: "dcrRegister", write: true },
    { kind: "verify", id: "verify", title: "Verify the credentials" },
    { kind: "golive", id: "golive", title: "Check what going live needs" },
  ] : [
    { kind: "browser", id: "open-console", title: `Open the ${guide.name} developer console`, url: `https://${guide.website}`, instruction: "Open the developer console's app list." },
    { kind: "browser", id: "create-app", title: "Create the OAuth app", instruction: "Create an OAuth app named %app_name% with redirect URI %redirect_uri%.", secrets: ["app_name", "redirect_uri"], write: true },
    { kind: "capture", id: "client-id", title: "Read the client ID", find: "the client ID", into: "client_id", secret: false },
    { kind: "capture", id: "client-secret", title: "Read the client secret into the vault", find: "the client secret", reveal: "the reveal button", into: "client_secret", secret: true },
    { kind: "verify", id: "verify", title: "Verify the credentials" },
    { kind: "golive", id: "golive", title: "Check what going live needs" },
  ];
  return {
    slug: guide.slug, name: guide.name, strategy: target.credential === "oauth" && target.dcr ? "dcr" : "browser", evidence: "unverified",
    ...(target.credential === "api_key" ? { credential: "api_key" as const, apiKey: { header: "Authorization", prefix: "Bearer", testUrl: `https://api.${guide.website}/me`, pick: "id" } } : {}),
    sandbox: { kind: "Test account", note: "From the guide's prerequisites." },
    oauth: {
      authorizeUrl: `https://${guide.website}/oauth/authorize`, tokenUrl: `https://${guide.website}/oauth/token`,
      whoami: { url: `https://api.${guide.website}/me`, pick: "id" }, scopes: guide.scopes?.minimalSets?.[0]?.scopes?.length ? guide.scopes.minimalSets[0].scopes : ["read"],
      consentInstruction: "Click Allow.", refresh: "if-enabled",
    },
    steps: {
      human: [{ kind: "human", id: "sign-in", title: "Sign in", reason: `Sign in to ${guide.name} in the live browser.` }, ...create],
      auto: [
        { kind: "identity", id: "identity", title: "Create the agent's inbox and password" },
        { kind: "browser", id: "signup", title: "Sign up", url: `https://${guide.website}`, instruction: "Sign up with %email% and %password%.", secrets: ["email", "password"], write: true },
        { kind: "email", id: "verify-email", title: "Confirm the email", extract: "link" },
        ...create,
      ],
    },
    goLive: { needed: !/never|none|not needed/i.test(guide.approval?.whenNeeded || ""), summary: guide.approval?.whenNeeded || "", humanWork: guide.approval?.submit || [] },
    notes: ["Generated from the guide. Unverified until a run succeeds."],
  };
}
