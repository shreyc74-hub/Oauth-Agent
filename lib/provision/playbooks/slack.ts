// Slack: the API-first path. apps.manifest.create returns the client ID and secret in the response,
// so no console clicking is needed once there's an app configuration token. That token is a shared
// bootstrap credential: generated once in the browser, then kept fresh with tooling.tokens.rotate.
// Evidence: tested setup attempt (attempts/slack.md) plus Slack's manifest API docs.
import type { Playbook, Step } from "../types";

const bootstrap: Step[] = [
  { kind: "browser", id: "open-apps", title: "Open Slack's app settings", url: "https://api.slack.com/apps",
    instruction: "Wait for the 'Your Apps' page. If asked to sign in, stop.", skipIfVault: "shared:config_refresh_token" },
  { kind: "browser", id: "gen-config-token", title: "Generate an app configuration token",
    instruction: "Under 'Your App Configuration Tokens', click Generate Token, choose the workspace '%workspace_name%' and click Generate.",
    secrets: ["workspace_name"], write: true, skipIfVault: "shared:config_refresh_token" },
  { kind: "capture", id: "config-token", title: "Store the configuration token", find: "the access token value of the configuration token just generated",
    reveal: "the Copy or show button for the access token", into: "shared:config_token", secret: true, skipIfVault: "shared:config_refresh_token" },
  { kind: "capture", id: "config-refresh", title: "Store the refresh token", find: "the refresh token value of the configuration token just generated",
    reveal: "the Copy or show button for the refresh token", into: "shared:config_refresh_token", secret: true, skipIfVault: "shared:config_refresh_token" },
];

const create: Step[] = [
  { kind: "api", id: "manifest-create", title: "Create the app from a manifest (apps.manifest.create)", handler: "slackManifestCreate", write: true },
  { kind: "verify", id: "verify", title: "Verify: install to the sandbox, auth.test, refresh" },
  { kind: "golive", id: "golive", title: "Check what going live needs" },
];

export const slack: Playbook = {
  slug: "slack",
  name: "Slack",
  strategy: "api",
  evidence: "tested",
  sandbox: { kind: "Developer sandbox workspace", note: "A Slack developer program sandbox or a free workspace used only for tests. Add a channel and a few messages before toolkit tests.", relation: "separate" },
  oauth: {
    authorizeUrl: "https://slack.com/oauth/v2/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    whoami: { url: "https://slack.com/api/auth.test", method: "POST", pick: "team" },
    scopes: ["chat:write", "channels:read"],
    scopeSeparator: ",",
    clientAuth: "body",
    consentInstruction: "On the Slack permission screen, make sure the workspace is '%workspace_name%' and click Allow.",
    refresh: "yes", // token rotation is switched on in the manifest
  },
  steps: {
    human: [
      { kind: "human", id: "sign-in", url: "https://slack.com/signin", title: "Sign in to the sandbox workspace", reason: "Sign in to your Slack sandbox workspace in the live browser. The agent does the rest through Slack's API." },
      ...bootstrap,
      ...create,
    ],
    auto: [
      { kind: "identity", id: "identity", title: "Create the agent's inbox" },
      { kind: "browser", id: "signup", title: "Create a Slack account with the agent's email", url: "https://slack.com/get-started#/createnew",
        instruction: "Type %email% into the email field and continue.", secrets: ["email"], write: true },
      { kind: "email", id: "confirm-code", title: "Read Slack's confirmation code", from: "slack", extract: "code", then: "Type the confirmation code %code% into the code boxes." },
      { kind: "browser", id: "workspace", title: "Create the sandbox workspace",
        instruction: "Create a new workspace named '%workspace_name%'. Skip adding teammates and skip optional steps until the workspace is open.",
        secrets: ["workspace_name"], write: true },
      ...bootstrap,
      ...create,
    ],
  },
  goLive: {
    needed: true,
    summary: "Works in up to 10 workspaces without review. Marketplace review lifts that and the history throttle.",
    humanWork: ["Listing content and scope justifications", "Security and compliance answers", "Demo video (install to uninstall)"],
  },
  notes: [
    "Config tokens expire after 12 hours; the agent rotates them before use and stores the new refresh token.",
    "One config token can create many apps in the same workspace, so the browser bootstrap runs once.",
  ],
};

/** The manifest the agent submits. Scopes come from the toolkit spec (here: the playbook). */
export function slackManifest(appName: string, redirectUri: string, scopes: string[]) {
  return {
    display_information: { name: appName.slice(0, 35), description: "Toolkit test app created by the provisioning agent" },
    features: { bot_user: { display_name: appName.slice(0, 80).toLowerCase().replace(/[^a-z0-9._-]+/g, "-"), always_online: false } },
    oauth_config: { redirect_urls: [redirectUri], scopes: { bot: scopes } },
    settings: { org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: true },
  };
}
