// Linear: no API for creating OAuth apps, so the app is created in the browser.
// Evidence: tested setup attempt (attempts/linear.md). A fresh workspace is the sandbox.
import type { Playbook, Step } from "../types";

const createApp: Step[] = [
  { kind: "browser", id: "open-new-app", title: "Open Settings, API, New application", url: "https://linear.app/settings/api/applications/new",
    instruction: "If a dialog offers to open the Linear desktop app, choose to continue in the browser. Wait for the 'Create new application' form." },
  { kind: "browser", id: "fill-form", title: "Fill the application form",
    instruction: "Fill the application form: Application name '%app_name%', Developer name '%dev_name%', Developer URL '%dev_url%', Description 'Toolkit test app created by the provisioning agent', Callback URLs '%redirect_uri%'. Turn ON the 'Public' toggle. Leave client credentials and webhooks off.",
    secrets: ["app_name", "dev_name", "dev_url", "redirect_uri"] },
  { kind: "browser", id: "create", title: "Create the application", instruction: "Click the Create button to create the application.", write: true },
  { kind: "capture", id: "client-id", title: "Read the client ID", find: "the Client ID value", into: "client_id", secret: false },
  { kind: "capture", id: "client-secret", title: "Read the client secret into the vault", find: "the Client secret value", reveal: "the button that reveals or shows the client secret", into: "client_secret", secret: true },
];

const finish: Step[] = [
  { kind: "verify", id: "verify", title: "Verify: OAuth flow, viewer query, refresh" },
  { kind: "golive", id: "golive", title: "Check what going live needs" },
];

export const linear: Playbook = {
  slug: "linear",
  name: "Linear",
  strategy: "browser",
  evidence: "tested",
  sandbox: { kind: "Free workspace", note: "A new Linear workspace on the free plan is the sandbox. Seed a team and a few issues before toolkit tests." },
  oauth: {
    authorizeUrl: "https://linear.app/oauth/authorize",
    tokenUrl: "https://api.linear.app/oauth/token",
    whoami: { url: "https://api.linear.app/graphql", method: "POST", body: { query: "{ viewer { id name email } }" }, pick: "data.viewer.name" },
    scopes: ["read", "write", "issues:create"],
    scopeSeparator: ",",
    clientAuth: "body",
    extraAuthorizeParams: { prompt: "consent" },
    consentInstruction: "On the Linear authorization screen, keep the default team access and click Authorize (or Approve).",
    refresh: "yes",
  },
  steps: {
    human: [
      { kind: "human", id: "sign-in", url: "https://linear.app/login", title: "Sign in and finish onboarding", reason: "Sign in to Linear in the live browser (or create the test workspace) and finish onboarding. New workspaces block Settings until onboarding is done." },
      ...createApp,
      ...finish,
    ],
    auto: [
      { kind: "identity", id: "identity", title: "Create the agent's inbox and password" },
      { kind: "browser", id: "signup", title: "Start sign-up with the agent's email", url: "https://linear.app/signup",
        instruction: "Choose to continue with email, type %email% into the email field and submit.", secrets: ["email"], write: true },
      { kind: "email", id: "login-code", title: "Read the sign-in code from the inbox", from: "linear", extract: "code", then: "Type %code% into the login code field and submit." },
      { kind: "browser", id: "workspace", title: "Create the test workspace",
        instruction: "Complete onboarding: create a workspace named '%workspace_name%', accept the suggested URL, skip inviting teammates and skip optional steps until the main Linear app is showing.",
        secrets: ["workspace_name"], write: true },
      ...createApp,
      ...finish,
    ],
  },
  goLive: { needed: false, summary: "No review. Public apps work for any workspace as soon as Public is on.", humanWork: [] },
  notes: [
    "Apps are private by default: the Public toggle is what lets other workspaces connect.",
    "Scopes are not set on the app. They are requested in the authorize URL.",
    "Access tokens last 24 hours; refresh tokens rotate.",
  ],
};
