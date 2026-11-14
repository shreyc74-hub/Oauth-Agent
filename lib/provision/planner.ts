// Picks the playbook for an app. Hand-written playbooks for the demo providers; for any other app the
// planner turns that app's readiness guide (the first assignment's output) into a playbook with Claude.
// The guide is the agent's map: no guide, no plan. Generated playbooks are marked "unverified".
import type { Guide } from "../schema";
import type { Mode, Playbook, Step } from "./types";
import { linear } from "./playbooks/linear";
import { slack } from "./playbooks/slack";
import { hubspot } from "./playbooks/hubspot";
import { runClaude, RESOLVE_MODEL } from "../agent/claude";

export const PLAYBOOKS: Record<string, Playbook> = { linear, slack, hubspot };

const KINDS = new Set(["identity", "browser", "capture", "email", "totp", "api", "human", "verify", "golive"]);

/** Structural checks for any playbook, hand-written or generated. Returns a list of problems. */
export function validatePlaybook(p: Playbook): string[] {
  const errs: string[] = [];
  if (!p.slug || !p.name) errs.push("slug and name are required");
  for (const u of [p.oauth?.authorizeUrl, p.oauth?.tokenUrl, p.oauth?.whoami?.url]) {
    if (!/^https:\/\/[^/]+\.[^/]+/.test(String(u || ""))) errs.push(`not an https URL: ${u}`);
  }
  if (!p.oauth?.scopes?.length) errs.push("no scopes");
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
    if (p.strategy !== "api" && !(captures.includes("client_id") && captures.includes("client_secret"))) errs.push(`${mode}: must capture client_id and client_secret`);
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
- Never put a secret value in an instruction. Secrets are captured with "capture" steps (into "client_id" secret:false, "client_secret" secret:true).
- Mark any step that creates, submits, accepts terms or installs as write:true.
- human mode starts with a human step "Sign in" and has no identity/email steps. auto mode starts with identity, then sign-up via %email%, email verification, then the same creation steps.
- Steps the guide says need a person (legal terms, business verification, payment) become human steps.
- Both modes end with verify then golive.
- Scopes: the smallest set from the guide's minimal sets.`;

/** Builds a playbook for an app that has a guide but no hand-written playbook. */
export async function planFromGuide(guide: Guide): Promise<Playbook> {
  const brief = {
    name: guide.name, website: guide.website, verdict: guide.verdict,
    steps: guide.steps, prerequisites: guide.prerequisites, appTypes: guide.appTypes?.items,
    scopes: guide.scopes?.minimalSets, approval: guide.approval, tokens: (guide as unknown as Record<string, unknown>).tokens,
  };
  const text = await runClaude({
    model: RESOLVE_MODEL,
    system: PLAN_SYSTEM,
    maxTokens: 6000,
    messages: [{ role: "user", content: `Guide for ${guide.name} (slug ${guide.slug}):\n${JSON.stringify(brief)}` }],
  });
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  const p = JSON.parse(json) as Playbook;
  p.slug = guide.slug; p.name = guide.name; p.evidence = "unverified";
  const errs = validatePlaybook(p);
  if (errs.length) throw new Error(`The generated plan for ${guide.name} failed checks: ${errs.slice(0, 4).join("; ")}`);
  return p;
}

/** Offline plan used in mock mode and tests: generic console steps from the guide. */
export function mockPlanFromGuide(guide: Guide): Playbook {
  const create: Step[] = [
    { kind: "browser", id: "open-console", title: `Open the ${guide.name} developer console`, url: `https://${guide.website}`, instruction: "Open the developer console's app list." },
    { kind: "browser", id: "create-app", title: "Create the OAuth app", instruction: "Create an OAuth app named %app_name% with redirect URI %redirect_uri%.", secrets: ["app_name", "redirect_uri"], write: true },
    { kind: "capture", id: "client-id", title: "Read the client ID", find: "the client ID", into: "client_id", secret: false },
    { kind: "capture", id: "client-secret", title: "Read the client secret into the vault", find: "the client secret", reveal: "the reveal button", into: "client_secret", secret: true },
    { kind: "verify", id: "verify", title: "Verify the credentials" },
    { kind: "golive", id: "golive", title: "Check what going live needs" },
  ];
  return {
    slug: guide.slug, name: guide.name, strategy: "browser", evidence: "unverified",
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
