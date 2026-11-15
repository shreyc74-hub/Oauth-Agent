// The research half of a run, decided before anything is created and before anyone picks a mode:
//   which credentials the vendor offers -> which one to provision -> how it gets created -> which
//   mode the agent recommends. Pure functions over evidence the agent gathered about the vendor itself
//   (quoted vendor pages, the guide it wrote, the DCR probe of the vendor's metadata). Nothing here
//   depends on an existing Composio toolkit: the agent is for vendors Composio has not built yet.
import type { Guide } from "../schema";
import type { Assessment, CredentialType, Mode, Playbook, SandboxCheck } from "./types";
import type { DcrResult } from "./dcr";

type Offered = Assessment["credentials"]["offered"];

const OAUTHY = new Set<CredentialType>(["oauth2", "oauth1", "client_credentials"]);
const KEYISH = new Set<CredentialType>(["api_key", "bearer"]);

/** Every credential type the evidence mentions, with where each claim came from. */
export function offeredCredentials(input: { sandbox?: SandboxCheck; guide?: Guide | null; playbook?: Playbook }): Offered {
  const out: Offered = [];
  const add = (type: CredentialType, source: string, note?: string) => { if (!out.some((o) => o.type === type && o.source === source)) out.push({ type, source, note }); };
  for (const o of input.sandbox?.offered || []) {
    add(o.type, o.quote?.found ? "vendor docs, quote found on the page" : "vendor docs, quote not confirmed", [o.where, o.selfServe === "no" ? "not self-serve" : ""].filter(Boolean).join("; ") || undefined);
  }
  if (input.sandbox?.credential?.apiKey) add("api_key", "sandbox check");
  if (input.sandbox?.credential?.oauth === "self_serve") add("oauth2", "sandbox check");
  if (input.playbook) add(input.playbook.credential === "api_key" ? "api_key" : "oauth2", "hand-written playbook");
  if (input.guide?.oauth?.supported) add("oauth2", "readiness guide");
  return out;
}

/** OAuth when it is self-serve, otherwise an API key, otherwise OAuth by default with the reason. */
export function chooseCredential(offered: Offered, sandbox?: SandboxCheck): { chosen: "oauth" | "api_key"; why: string } {
  const oauthPart = sandbox?.parts?.find((p) => p.role === "oauth_app");
  const oauthBlocked = sandbox?.credential?.oauth === "partner_only" || sandbox?.credential?.oauth === "none" || oauthPart?.verdict === "gated";
  const notSelfServe = (t: CredentialType) => offered.some((o) => o.type === t && /not self-serve/.test(o.note || ""));
  const oauth = offered.some((o) => OAUTHY.has(o.type) && !notSelfServe(o.type)) && !oauthBlocked;
  const key = offered.some((o) => KEYISH.has(o.type) && !notSelfServe(o.type));
  if (oauth) return { chosen: "oauth", why: `The vendor offers OAuth${key ? " and an API key" : ""}. OAuth is what a Composio toolkit uses for its users, so the agent creates an OAuth app.` };
  if (key) return { chosen: "api_key", why: oauthBlocked ? "OAuth is only for partners or approved apps, but an API key is self-serve, so the agent creates an API key." : "The vendor offers an API key and no self-serve OAuth, so the agent creates an API key." };
  return { chosen: "oauth", why: "No credential type was confirmed; the agent assumes OAuth from the guide." };
}

/** The best route for creating the chosen credential that this agent can run today, with the better ones it can't yet. */
export function chooseRoute(input: { chosen: "oauth" | "api_key"; playbook?: Playbook; dcr?: DcrResult; sandbox?: SandboxCheck }): Assessment["route"] {
  const { chosen, playbook: p, dcr } = input;
  if (chosen === "api_key") {
    const where = input.sandbox?.offered?.find((o) => KEYISH.has(o.type))?.where;
    return { method: "API key from the dashboard", detail: `Signed in to the account, the agent creates a key${where ? ` (${where})` : " in the account's API settings"}, reads it straight into the vault, and checks it with one API call.`, executable: true };
  }
  if (p?.strategy === "api") return { method: "Management API", detail: "Created through the vendor's API (hand-written playbook).", executable: true };
  if (dcr?.available && dcr.kind === "api" && dcr.registrationEndpoint) {
    return { method: "Dynamic Client Registration", detail: `One API call to ${dcr.registrationEndpoint}. If the vendor requires an initial access token, the run stops and says so; the browser route is the fallback.`, executable: true, fallback: "Browser automation" };
  }
  const c = input.sandbox?.creation;
  const LABEL = { management_api: "Management API", cli: "CLI", manifest: "Manifest + one click" } as const;
  if (c) return { method: "Browser automation", detail: "The agent fills the developer console.", executable: true, fallback: `Better route found in the vendor's docs, not automated yet: ${LABEL[c.kind]} (${c.detail})` };
  const mcp = dcr?.available && dcr.kind === "mcp" ? ` The vendor's MCP server accepts self-registration (${dcr.registrationEndpoint}), which only helps MCP-based toolkits.` : "";
  return { method: "Browser automation", detail: `No registration endpoint and no known API, so the agent fills the developer console.${mcp}`, executable: true };
}

/** Which modes can run here, and which the agent recommends. */
export function recommendMode(input: { missing: Record<Mode, string[]>; playbook: Playbook; sandbox?: SandboxCheck; route: Assessment["route"] }): Pick<Assessment, "modes" | "recommendedMode" | "recommendWhy"> {
  const modes: Assessment["modes"] = {
    human: { available: !input.missing.human.length, why: input.missing.human.length ? `Missing ${input.missing.human.join(", ")}.` : "You sign in; the agent asks before every create, submit or consent." },
    auto: { available: !input.missing.auto.length, why: input.missing.auto.length ? `Missing ${input.missing.auto.join(", ")} (the agent's own inbox for sign-up).` : "The agent signs up with its own inbox and only stops for captchas, phone checks or legal steps." },
  };
  let rec: Mode = "human", why: string;
  if (!modes.auto.available) why = `Full automation can't run here: ${modes.auto.why}`;
  else if (input.playbook.evidence === "unverified") why = "The plan is generated and has not been run before, so approving each create and consent is safer the first time.";
  else if (input.sandbox?.verdict === "unknown") why = "A self-serve sandbox wasn't confirmed, so a person should watch the first attempt.";
  else { rec = "auto"; why = `The plan is ${input.playbook.evidence === "tested" ? "tested" : "from the vendor's docs"} and every step is self-serve, so the agent can do it alone and hand over only at walls.`; }
  return { modes, recommendedMode: rec, recommendWhy: why };
}

export function stepSummary(p: Playbook): Assessment["steps"] {
  return (["human", "auto"] as Mode[]).map((mode) => ({ mode, count: p.steps[mode].length, human: p.steps[mode].filter((s) => s.kind === "human").map((s) => s.title) }));
}
