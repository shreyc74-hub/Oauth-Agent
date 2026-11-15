// HubSpot: the one provider with a real sandbox (developer test accounts). Apps on HubSpot's
// developer platform are projects deployed with the CLI; the console still shows the Auth tab with
// the client ID and secret. The agent creates the test account and the app in the browser, and hands
// over to a person if HubSpot insists on the CLI. Evidence: official docs (not tested end to end yet).
import type { Playbook, Step } from "../types";

const build: Step[] = [
  { kind: "browser", id: "test-account", title: "Create a developer test account (the sandbox)", url: "https://app.hubspot.com/",
    instruction: "Open the developer account's Development area, then Test accounts. Create a developer test account named '%workspace_name%'. Wait until it appears in the list.",
    secrets: ["workspace_name"], write: true },
  { kind: "capture", id: "sandbox-url", title: "Note the test account's portal ID", find: "the Hub ID / portal ID of the test account named after the workspace", into: "sandbox_id", secret: false },
  { kind: "browser", id: "create-app", title: "Create the OAuth app",
    instruction: "In the Development area open Apps (or Legacy apps). Create a public app named '%app_name%' (if asked, choose a public / marketplace app, not a private app). On its Auth tab set the redirect URL to %redirect_uri%, add the scopes oauth, crm.objects.contacts.read and crm.objects.companies.read, and save. If HubSpot says apps can only be created with the CLI, stop.",
    secrets: ["app_name", "redirect_uri"], write: true },
  { kind: "capture", id: "client-id", title: "Read the client ID", find: "the Client ID on the app's Auth tab", into: "client_id", secret: false },
  { kind: "capture", id: "client-secret", title: "Read the client secret into the vault", find: "the Client secret on the app's Auth tab", reveal: "the Show button next to the client secret", into: "client_secret", secret: true },
  { kind: "verify", id: "verify", title: "Verify: install into the test account, account details, refresh" },
  { kind: "golive", id: "golive", title: "Check what going live needs" },
];

export const hubspot: Playbook = {
  slug: "hubspot",
  name: "HubSpot",
  strategy: "browser",
  evidence: "docs",
  sandbox: { kind: "Developer test account", note: "Free test portal with trial tiers, renewable from the developer account. Before the AUP is signed, installs only work in test accounts, which is exactly what toolkit testing needs.", relation: "separate" },
  oauth: {
    authorizeUrl: "https://app.hubspot.com/oauth/authorize",
    tokenUrl: "https://api.hubapi.com/oauth/v1/token",
    whoami: { url: "https://api.hubapi.com/account-info/v3/details", method: "GET", pick: "portalId" },
    scopes: ["oauth", "crm.objects.contacts.read", "crm.objects.companies.read"],
    scopeSeparator: " ",
    clientAuth: "body",
    consentInstruction: "On the HubSpot screen, choose the test account '%workspace_name%' and click Choose Account, then Connect app.",
    refresh: "yes",
  },
  steps: {
    human: [
      { kind: "human", id: "sign-in", url: "https://app.hubspot.com/login", title: "Sign in to the HubSpot developer account", reason: "Sign in to your HubSpot developer account in the live browser." },
      ...build,
    ],
    auto: [
      { kind: "identity", id: "identity", title: "Create the agent's inbox and password" },
      { kind: "browser", id: "signup", title: "Sign up for a developer account", url: "https://app.hubspot.com/signup-hubspot/developers",
        instruction: "Fill the sign-up form with email %email%, first name 'Toolkit', last name 'Agent', and continue.", secrets: ["email"], write: true },
      { kind: "email", id: "verify-email", title: "Confirm the email address", from: "hubspot", extract: "link" },
      { kind: "browser", id: "set-password", title: "Set the password and finish sign-up",
        instruction: "Set the password to %password% and complete the remaining sign-up questions with neutral answers (company 'Toolkit Test', role 'Developer') until the developer account home is showing.",
        secrets: ["password"], write: true },
      ...build,
    ],
  },
  goLive: {
    needed: true,
    summary: "Unlisted apps cap at 25 installs. Beyond that, a marketplace listing and HubSpot's review.",
    humanWork: ["Sign HubSpot's Acceptable Use Policy (installs outside test accounts need it)", "Listing content", "Install and usage requirements per HubSpot's listing rules"],
  },
  notes: [
    "Apps on the 2025.2+ developer platform are projects (app-hsmeta.json) deployed with `hs project upload`. A worker running the CLI with a personal access key is the API path; the browser path is the fallback.",
    "Test accounts run on trials; renew them from Developer test accounts, Actions, Renew trials.",
  ],
};
