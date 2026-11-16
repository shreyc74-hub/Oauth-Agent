# Provisioning agent: app name in, sandbox and working credentials out

Composio's toolkit factory can research an app and generate a production-ready toolkit on its own. Two steps still need a person: getting a sandbox to test the toolkit in, and creating the OAuth app whose credentials the toolkit runs on. This agent is that missing stage.

You type an app name. The agent does all the research first, with no browser and nothing for you to decide:

1. **Sandbox.** Can a stranger get a working test setup without sales or a partner programme? If not, it stops here with the reason, the quotes and what a person would have to do. This comes first, before any guide exists, so a gated vendor costs one quick check instead of a full guide.
2. **Guide.** Only if a test setup is possible (or not ruled out): it finds the app's readiness guide (the first assignment's output), or researches one. The sandbox verdict is cached, so it is not researched twice.
3. **Accounts.** Is the sandbox the same account as the developer side (Linear, BambooHR) or a separate one (Slack, HubSpot, Zoho)?
4. **Credentials.** Which credential types the vendor offers (OAuth 2, OAuth 1, client credentials, API key, JWT, service account, basic), each backed by a quote from the vendor's own pages.
5. **What to provision.** An OAuth app when OAuth is self-serve, otherwise an API key.
6. **How to create it.** For OAuth: Dynamic Client Registration if the vendor's metadata offers it, then a documented management API, CLI or manifest, and the browser as the last resort. For an API key: the account's dashboard.
7. **A plan and a recommendation:** human in the loop or full automation, and why.

Then you choose the mode and start. The run creates the accounts and the credential, puts every secret in a vault the model never sees, and proves the credential works: for OAuth a real authorization, token exchange, identity call, use-case call and refresh; for an API key one read-only call. Finally it flags what going live needs. Production review is listed as human work, not attempted.

None of this depends on Composio already having a toolkit for the app. The agent is for the vendors the toolkit factory has not built yet, so everything it knows about a vendor comes from that vendor's own pages and metadata. The survey of Composio's existing 1,745 toolkits in `research/` was used only to decide which creation routes to build first.

A tracker row per run goes to a Google Sheet: status, sandbox, masked client ID, vault names, who the token works for, and what still needs a person. Never a secret.

**Scope decision.** This covers test credentials. Production approval (Google's verification with demo videos and documents, Slack's marketplace review, HubSpot's listing) is flagged per app with what a person has to submit. Automating those would mean an agent filling legal and security forms on a company's behalf, which it shouldn't.

**Status at a glance (2026-11-16).** 39 runs on the deployed app. Full automation through the hosted browser agent verified 7 apps end to end with nobody involved (Deepgram, Typeform, Zoom, Slack twice, ClickUp, Mailchimp), in 2 to 17 minutes each, and created the app or key in 6 more. Human in the loop is built and tested offline but has not completed a live run. Most remaining failures come from the agent's identity (a shared public email domain, bot checks), not from screens it can't handle. Details: [Live results](#live-results).

## Try it

- **Demo mode** (no accounts): `PROVISION_MOCK=1 npm run dev`, open `/provision`. The browser, inbox and provider APIs are simulated; the plans, state machine, pauses, approvals, vault writes, reveal logging and sheet rows are the real code.
- **Real runs:** set the keys in [Setup](#setup), then use `/provision` or the terminal: `npm run provision -- linear` (add `--auto` for full automation).
- **Tests:** `npm test` (194 tests, all offline, including the sandbox check, use-case scopes and the hosted browser route).

## How an app gets its OAuth app: four routes

Browser automation is the fallback, not the strategy.

| Strategy | When | Example in this build |
|---|---|---|
| **DCR** | The vendor's OAuth server accepts self-registration (RFC 7591) | One POST creates the app. If the endpoint wants a token, the hosted browser agent fetches one first; if it still refuses (Typeform only accepts trusted redirect domains), the run falls back to the console automatically. |
| **API** | The provider lets you create apps through an API | Slack: `apps.manifest.create` returns the client ID and secret in the response. The only browser work is a one-time bootstrap of an app configuration token, done by the hosted browser agent, kept fresh with `tooling.tokens.rotate` and reused by every later run, which then needs no browser to create the app. |
| **Browser** | No API, but a self-serve console | The hosted browser agent (Browser Use) signs up and creates the app in the console from the research. Verified live: Zoom, ClickUp, Mailchimp, Typeform. |
| **Human** | The step needs a person by policy or law | Phone checks, payment, push-app MFA, bot checks the solver can't pass, production review. |

**Choosing the mode last.** Picking human in the loop or full automation before the agent knows the vendor would decide how a person gets involved without knowing what the job is. So a run is created research-first and stops at "Ready to start" with the findings. The agent recommends a mode: full automation when the plan is tested or from the vendor's docs and the agent's inbox is configured, a person when the plan is generated and unverified or a sandbox wasn't confirmed. The person picks and starts.

**One research call, not a guide.** The sandbox check's research also collects what provisioning needs from the vendor's official pages: the sign-up and app-creation pages, the steps in order, the OAuth endpoints and a minimal scope set (or, for an API-key vendor, the header and a test call). Code keeps only well-formed parts. When an app has no guide, the plan is written from this brief, which is not saved to the Library; a full guide is researched only when the brief is missing. That is one research call per new vendor instead of two. The browser agent's per-click decisions run on a small model (`STAGEHAND_MODEL`); research, planning and recovery keep the default.

**Zero touch.** With "Run it end to end without me" (on by default), full automation starts by itself when the research finishes. In full automation a not-confirmed sandbox is logged and tried instead of asked about (a gated verdict still stops the run before anything is created), and the OAuth part counts the guide's self-serve creation steps or a DCR endpoint as evidence when no quote says who may create apps. With `PROVISION_ACCEPT_TERMS=1`, set by the owner, the agent accepts vendor developer terms for test accounts and logs each acceptance; payment, phone, identity and business checks always go to a person. Captchas are handed over once per vendor: the shared mailbox's account and the vendor's saved browser context are reused, so later runs for that vendor don't meet them.

**One mailbox, one login per vendor.** With `PROVISION_INBOX_ID` set, full automation uses that one AgentMail inbox for every run instead of creating an inbox per run. Each vendor gets one password, kept in the vault as a shared secret. The first run for a vendor signs up; once that sign-up is confirmed on the page, the vault records that the account exists, and later runs for that vendor sign in instead (their email steps wait only a minute, since a sign-in often sends no email). Runs only read mail that arrived after their own step started.

**API keys.** When OAuth is partner-only but an API key is self-serve (BambooHR), the vendor is not treated as gated: the plan creates a key in the account's dashboard, a capture step reads it straight into the vault, and verification makes one read-only call with it.

**Looking for an API route first: Dynamic Client Registration.** Some vendors let a client register itself with one API call (RFC 7591). They say so in public metadata: a `registration_endpoint` in `/.well-known/oauth-authorization-server` or `/.well-known/openid-configuration`. MCP servers publish `/.well-known/oauth-protected-resource`, which points at their authorization server, and the MCP authorization spec builds on this kind of registration, so many SaaS MCP servers accept it. Every run probes these documents on the vendor's OAuth hosts, its site, `api.`, `auth.` and `mcp.`, in code and without the model, and shows the result on the run page: offered by the main OAuth server, offered only by the MCP server (whose tokens may only work for MCP), or not offered. A registration endpoint is trusted only over https on the vendor's own domain. The probe only reads. When the vendor's main OAuth server offers it, the plan uses it: one POST to the registration endpoint creates the app (an approval card in human mode), the client secret and registration access token go straight to the vault, and verification authorizes against that server's endpoints. If the endpoint wants an initial access token, the run says so and the browser route is the fallback. Other non-browser routes worth adding per vendor: management APIs (Microsoft Graph applications, Okta, Auth0, Zendesk OAuth clients), vendor CLIs and Terraform providers, and manifest flows where a person clicks once (GitHub App manifests).

HubSpot sits in between: on the 2025.2+ developer platform apps are projects deployed with the CLI (`hs project upload`). A worker running the CLI with a personal access key is the API path; the browser path in this build is the fallback, and it hands over if HubSpot insists on the CLI. HubSpot is also the one demo provider with a real sandbox: developer test accounts.

Apps without a hand-written playbook get their plan from the research brief. On the DCR and hosted-browser routes that plan is built in code with no model call; human-in-the-loop steps (click-by-click) are planned by Claude only when someone picks that mode. Every plan is checked by code (`validatePlaybook`: https endpoints, secrets only through variables, credentials produced, a verify step, no agent identity in human mode) and marked unverified until a run succeeds. When the research brief misses the OAuth endpoints and the vendor publishes no metadata (Figma), one small follow-up call looks up just those.

## Step one: is a self-serve test setup possible?

Before planning or opening a browser, the agent answers three separate questions, because a developer account is not always a sandbox:

| Part | The question | Examples |
|---|---|---|
| Developer side | Where is the OAuth app created and managed, and can anyone get in? | Slack: api.slack.com/apps. Zoho: the API Console. HubSpot: a developer account. |
| Sandbox | What working environment is the app tested in? The same account or a separate one? Can anyone create it, and does it expire? | Slack: a workspace (separate). HubSpot: a developer test account (separate). Zoho Invoice: an Invoice organization (separate). Linear: the same workspace. |
| OAuth app | Can anyone create an OAuth app, or is OAuth for partners only, with an API key as the self-serve option? | BambooHR: API key from the dashboard, OAuth for marketplace partners. |

How each answer is validated, so the model can't simply assert it:

1. The research agent reads the vendor's own pages and returns, per part, a sign-up URL and quotes copied word for word: "yes" quotes (free developer account, sandbox, free trial) and "no" quotes (contact sales, partners only, existing customers only).
2. Code fetches every cited page and keeps a quote only if it is really on that page. Paraphrased or invented quotes are dropped and shown as dropped.
3. Code probes each sign-up URL. Email and password fields or "Sign up with Google" look self-serve; "Request a demo" or "Contact sales" with no form looks gated.
4. Code combines the found quotes and the probe into a verdict per part, and the run takes the weakest part:
   - **Self-serve**: found quotes say yes and the sign-up page is a real form. The run goes ahead.
   - **Likely self-serve**: one kind of evidence says yes and nothing says no. The run goes ahead, flagged.
   - **Gated**: a found quote says sales, partner or customers only. The run stops before planning, with the quotes, links and what a person would have to do.
   - **Not confirmed**: no evidence either way, or the sources disagree. The run's first step asks the person to continue or cancel, without opening a browser.
5. A verified run overrides research: the vendor is recorded as self-serve "from a verified run". Research verdicts are cached per vendor for two weeks.

Only quoted evidence can stop a run. A sales-looking page on its own, or the model's opinion, cannot.

For generated plans, the planner gets this map. When the sandbox is a separate account, the plan creates or opens it before authorizing, and consent picks that sandbox. Hand-written playbooks carry the same fact (Linear: same account; Slack and HubSpot: separate).

## Scopes from the use case

The start page asks what the app will do ("read invoices and create customers"). The agent maps that to the vendor's exact scope strings, using the guide's scope table, picks the smallest set that covers it, and picks one read-only API call from the use case. Code keeps that call only if it is a GET to the vendor's own domain, so the new token can't be sent anywhere else. Verification makes the call; if it fails, the run ends as needs review ("sign-in works, but the use-case call failed"). Without a use case, the plan's scopes are used: fixed ones for the hand-written playbooks, and the smallest of the guide's minimal sets for generated plans. Such a run can still be verified, but it is labelled **verified for sign-in only** on the run page, in the runs list, in the log and in the tracker sheet: the credentials work, and the scopes were not checked against what the app will do.

In production, nobody should have to type the use case. The toolkit factory already knows it: the toolkit's list of actions and the endpoints they call. Passing that list in as the use case would give every app the scopes its toolkit needs and a test call from a real action.

## Two modes

| | Human in the loop | Full automation |
|---|---|---|
| Browser | Our Browserbase browser (Stagehand), live view in the page | Browser Use through Composio (hosted browser agent), live view linked from the page |
| Developer account | You sign in, in the live browser | Agent signs up with the shared inbox (AgentMail) and a password from the vault |
| Email codes and magic links | You | Code reads the inbox and resumes the same browser with the code or link |
| Authenticator 2FA | You | Agent picks email or an authenticator app; the setup key goes to the vault and code generates the codes |
| Creates, submits, consent | Agent, after you approve each one | Agent |
| Captchas | You (solving is off in our browser) | Browser Use's solver, allowed for test accounts; a person if it still blocks |
| Phone/SMS, push-app MFA, payment | You | You (the run pauses with the live view) |

**Status:** full automation is verified live on 7 apps. Human in the loop has been tested offline only: its live attempts all predate the switch to the hosted browser agent, and none reached verified.

## Full automation's browser route: a hosted browser agent

When `COMPOSIO_API_KEY` is set, full automation hands the browser part to **Browser Use**, called through Composio's tool API, instead of our own step-by-step browser playbook. Our app stays in charge; Browser Use only drives the browser.

1. Research as before: sandbox check, credential choice, route. DCR, management API and manifest routes still come first and need no browser.
2. For the browser route the plan becomes three steps: agent identity (shared inbox and password), **hosted agent**, verify.
3. Our app writes the hosted agent's task from the research: the goal (OAuth app or API key), the values (names, redirect URL, scopes), the vendor's steps as hints ("trust the screen over these"), the rules (skip optional prompts such as "add your phone number"; stop only at a mandatory phone, payment, captcha or bot check; never solve a captcha), and a fixed JSON answer shape.
4. The account password goes as a Browser Use bound secret for the vendor's own domains, never in the task text.
5. Between Browser Use runs, in the same browser session:
   - **Email:** the agent stops with `waiting_for_email`; our app reads the code or sign-in link from our inbox (codes in HTML-only mails included) and starts the next run with it.
   - **Wall:** the run pauses for a person with Browser Use's live view; after Continue the agent carries on in the same browser.
   - **Done:** the client ID is stored, the secret or key goes straight to the vault and is redacted from the log. If the secret didn't come back, the run asks a person to paste it into the vault.
6. Verification: the hosted browser, already signed in, approves the consent screen; our callback route catches the code; our app exchanges it, calls the identity endpoint and tests refresh.

Human in the loop keeps the Browserbase live browser. `PROVISION_BROWSER_AGENT=stagehand` turns the hosted route off.

**Captchas (decision 2026-11-15):** Browser Use's cloud browsers solve captchas server-side on their own, and the agent can't switch that off through Composio. Allowed for test accounts: the agent waits for the solver, and stops only for a mandatory phone number or payment, or a check that still blocks after waiting twice. `PROVISION_CAPTCHA=handover` tells the agent to stop at every captcha again (the platform may still solve some before the agent sees them). Our own Browserbase browser (human in the loop) keeps captcha solving off. The risk that comes with this: vendor terms that forbid automated sign-ups, and account bans.

**Two-step verification:** when a vendor makes the account set up a second factor, the agent picks email if offered (our inbox handles it), otherwise an authenticator app (Google Authenticator or "other app", never a push app like Okta Verify or SMS). It opens "Can't scan? / enter key manually", stops with `needs_totp` and returns the text setup key. Our app stores the key in the vault as a shared per-vendor secret, generates codes (RFC 6238) and resumes the same browser with the codes for the next four minutes, each with its UTC window, so a code is still valid when the agent types it. A later run that is asked for a code at sign-in gets codes from the stored key. With no key on file the run hands over. The setup key passes through Browser Use's run result, like the client secret. A mandatory push app or SMS code is still a wall.

**What this costs in trust:** the client secret or API key passes through Browser Use's run result (and so Browser Use's records) on its way to our vault. Attaching our own code to Browser Use's browser to read the secret directly would avoid that; it was not reachable in testing and is a follow-up.

**How the app reaches Browser Use:** with a Composio consumer key (`ck_…`) through Composio's MCP endpoint (`connect.composio.dev/mcp`), the same route Composio's own MCP clients use. It reaches Composio's free shared Browser Use account (model `gpt-5.6-luna`, $5 cap per run, bound secrets accepted, Browser Use's built-in mailbox not available). Every call in the live tests was charged $0.00 under a limited-time offer. Live results are under [Live results](#live-results).

## Lean research (cost)

Research cost is driven by context size, not call count: every fetched page stays in the conversation and is re-read on each step. So:

1. **No planning call where nobody needs click-by-click steps.** For Dynamic Client Registration, and for full automation through the hosted browser agent, the plan is built from the research brief in code (`briefPlaybook`). Human-in-the-loop steps are planned only if someone picks that mode.
2. **One research call, small budget:** at most 3 searches and 3 fetches, pages cut to 6,000 tokens (was 6, 8 and 30,000). `PROVISION_RESEARCH=full` restores the old budget.
3. **Knowledge first:** the model answers from what it knows and searches only to confirm URLs, quotes, endpoints and scopes.
4. **Free checks in code:** OAuth authorize and token URLs come from the vendor's own metadata when the brief lacks them; quotes are still checked against the pages by code.

With DCR and full automation, verification signs up (or signs in) in the hosted browser and approves consent there.

Not measured yet: token and search counts per run aren't recorded, so the saving is an estimate.

## Three kinds of credentials, and where each goes

1. **Developer account login** (email, password, TOTP seed). Only in full automation. Generated straight into the vault.
2. **Sandbox account.** The test workspace or portal. Its name and ID are recorded on the run; logins for it are the developer account's.
3. **OAuth app credentials and tokens** (client ID and secret, signing secret, access and refresh tokens). Client ID is not secret and is shown; everything else goes to the vault.

Bootstrap credentials shared across runs (Slack's config refresh token, the per-provider browser context that keeps a console signed in) are stored under `<provider>/shared/...`. Per-run secrets are under `<provider>/<run id>/...`.

## How secrets stay away from the model

- **Typing secrets:** browser steps use Stagehand variables (`%password%`). Variable values are not sent to the model.
- **Reading secrets:** the model locates the field while it is still masked, code clicks "reveal", then code reads the value with a fixed selector and writes it to the vault. The value never enters a prompt.
- **Codes and links from email** are pulled out with plain code.
- **Storage:** Supabase Vault (encrypted at rest), reached only through two `security definer` SQL functions that only the service role can run (`supabase/provision.sql`). Runs and the sheet hold vault names.
- **Logs:** every event passes through redaction of the secret values seen in that run.
- **Reveal:** anyone with the link can reveal the credentials a run created, because handing them over is the point of the agent. Every reveal is written to the run's audit log and, with Supabase, to the append-only `provision_reveals` table first; if that write fails the reveal is refused. Setting `PROVISION_ADMIN_TOKEN` puts reveals behind a token.
- **Access:** the deployment is open, so anyone with the link can run the agent in either mode. Starting a run is limited to 20 per network per hour. Setting `PROVISION_ACCESS_CODE` puts real runs behind a code. A production version would tie runs and reveals to signed-in users and their own workspaces.

Known limit: if a console shows a secret in plain text before any reveal (Slack's config token page may), the model's page snapshot can include it during the locate step. That bootstrap runs once per workspace; a production version would read that one field with a fixed selector.

## How a run works

A run is a state machine stored in Supabase after every step, so it survives serverless time limits and can pause for hours:

`queued → running → (waiting_human | waiting_approval) → running → … → verified | needs_review | failed | cancelled`

- The page calls `/advance`; each call runs steps until a pause or about 4 minutes, then the page calls again. A short lease stops two tabs from running the same step.
- The hosted browser is kept alive between calls and reconnected by session ID. Its live view is embedded in the page, so a person can take over in the same browser.
- After every browser action the agent asks "is there a wall here?" (captcha, phone, device, payment, sign-in, error). A wall becomes a handoff; after the person clears it, the same step runs again.
- Anything else the agent can't finish also becomes a handoff, not a dead run. If it can't read a value, the person can paste it into a field that writes straight to the vault.
- Missing setup (no browser key, no inbox key) stops the run with the reason instead of looping.

## Workflow and agent: which part is which

The backbone is a workflow, on purpose. Code decides the order of steps, keeps the run state, stores secrets, stops for approvals and runs verification. That is what makes the vault boundary, the approvals and the audit log dependable.

The model makes decisions in these places:

| Where | What the model decides | What code still controls |
|---|---|---|
| Research | Sandbox, credential types, endpoints and steps from the vendor's pages | Quotes checked against the pages, sign-up page probed, DCR metadata read |
| Hosted browser agent (Browser Use) | Every click of sign-up, app creation and consent in full automation | The task, the rules, email codes and links, walls, the vault, verification |
| Planner | The human-in-the-loop playbook for an app with no hand-written one | Structural checks; plan marked unverified |
| Each browser step | What to click and type on the page (Stagehand) | The step's goal, order and approval point |
| Wall check | Whether a captcha, phone check or similar is showing | What happens next: a handoff |
| **Recovery agent** | How to reach a failed step's goal another way | Tools, budget, allowed sites, approvals, secrets |

**The recovery agent.** When a browser or capture step fails (the console changed, a button moved, a dialog got in the way), the step's goal goes to a short agent loop before a person is asked. It has seven tools: look, act, capture (page to vault), read inbox code, open the email's sign-in link, ask a human, and done. Codes and links are used by code: the model is told only that the code is available as %code% or that the link was opened. Email steps get it too: when the emailed code can't be read or entering it doesn't finish the sign-in, the recovery agent looks at the page and chooses between "enter the code" and the link. Code decides what it is allowed to do:

- It never receives a secret. Values go page to vault through capture, it is told only "stored", and anything it reads from the page is redacted against every secret the run holds.
- In human-in-the-loop mode, any create, submit or consent action it attempts stops for approval. The person approves that exact action; the step runs again and the agent may do it.
- A captcha, phone check, device prompt or payment form ends the loop with a handoff.
- It can only navigate to the provider's own sites; anything else is refused or reversed.
- It has 8 actions and 2 minutes. If it gives up, the handoff tells the person what it tried.

When it recovers, it suggests a playbook fix ("the control moved into the sidebar menu"). Fixes are shown on the run for a person to review, not applied automatically. That is how playbooks keep up with consoles that change.

Switch it off with `PROVISION_RECOVERY=0`. In demo mode, tick "Simulate a console change" to watch it work on Linear.

## Background driver

Runs used to move forward only while their page was open (the page calls `/advance`). A Vercel cron now calls `/api/cron/advance` every minute; it advances every queued or running run (up to six at a time; a run already being advanced is skipped by its lease). Runs waiting for a person or an approval are left alone. Set `CRON_SECRET` in Vercel to lock the route to Vercel's cron.

## Verification

A run is **verified** only if all of this works against the sandbox:

1. Open the authorize URL with a random `state` and a PKCE S256 challenge (Airtable requires PKCE; servers that don't use it must ignore it), approve consent in the hosted browser, choosing the workspace the app belongs to.
2. Read the code from the browser's address bar (checking `state`), or from the callback route as a backup.
3. Exchange the code at the token endpoint. Slack's `ok:false` answers are treated as failures.
4. Call an identity endpoint (Linear `viewer`, Slack `auth.test`, HubSpot account details).
5. If a use case was given: make its read-only test call, which proves the scopes cover what the app will do.
6. Use the refresh token and store the new tokens (refresh tokens can rotate, so the old one may stop working).

Otherwise the run ends as **needs review** with the reason.

When the identity call's reply lacks the planned field, a common identity field (login, email, name, account name, id) names the account; a successful identity call counts even without one. When the identity call itself fails (for example a POST-only endpoint), a working use-case call proves the token instead. Client IDs are public and stay readable in the log.

## Setup

| What | Why | Env |
|---|---|---|
| Supabase | Runs and the vault. Run `supabase/schema.sql`, then `supabase/provision.sql`. | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |
| Browserbase | Hosted browser with live view | `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID` |
| Anthropic | Stagehand's model and planning | `ANTHROPIC_API_KEY` (optional `STAGEHAND_MODEL`) |
| AgentMail | Agent inboxes, full automation only; one shared inbox for every run | `AGENTMAIL_API_KEY`, `PROVISION_INBOX_ID` |
| Background driver | Vercel cron advancing runs every minute (`vercel.json`) | optional `CRON_SECRET` |
| Policy switches | Captchas on test accounts (`allow_test` or `handover`), developer terms, research budget | `PROVISION_CAPTCHA`, `PROVISION_ACCEPT_TERMS`, `PROVISION_RESEARCH` |
| Composio (Browser Use) | Hosted browser agent for full automation. Connect Browser Use in Composio for the user below. | `COMPOSIO_API_KEY`, optional `COMPOSIO_USER_ID`, `COMPOSIO_CONNECTED_ACCOUNT_ID`, `BROWSER_USE_MODEL` |
| Google service account | Tracker sheet (share the sheet with its email as Editor) | `GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_SHEET_ID` |
| Access (optional) | Lock runs and reveals behind a code; open when unset | `PROVISION_ACCESS_CODE`, `PROVISION_ADMIN_TOKEN` |
| Redirect URI | `<this>/api/oauth/callback` on every app | `PUBLIC_BASE_URL` |

## Live results

39 runs on the deployed app, 2026-11-15 and 2026-11-16, all with the shared inbox `shrey-4990@agentmail.to`. "Old engine" is our own step-by-step browser (Browserbase and Stagehand), used before the hosted browser agent existed.

| | Runs | Verified | App or key created, not verified | Stopped before creating anything |
|---|---|---|---|---|
| Old engine | 13 | 0 | 0 | 13 |
| Hosted browser agent (Browser Use through Composio) | 26 | 7 | 6 | 13 |
| Total | 39 | 7 | 6 | 26 |

### Verified (full automation, nobody involved)

| App | Route | Time from start | Notes |
|---|---|---|---|
| Deepgram | API key | 2.1 min | One emailed code; key checked with its `Token` prefix |
| Typeform | DCR, then console | 5.5 min | DCR refused our redirect domain; the run switched to the console by itself. Use-case call ok |
| Zoom | Console | 8.1 min | Two emailed codes (sign-up, then an "unusual sign-in" code) |
| Slack | API with a token from the hosted agent | 8.2 min | App created by `apps.manifest.create` 4 seconds after the token arrived. Use-case call and refresh ok |
| ClickUp | Console | 8.9 min | Vendor has no scopes. Use-case call ok |
| Mailchimp | Console | 9.9 min | |
| Slack | Console (before the token route) | 16.5 min | Use-case call ok |

On a second Slack run the app was created through the API in 42 seconds with no browser at all; its consent then failed on the workspace bug below.

### Why the others stopped

| Category | Runs | Apps | State |
|---|---|---|---|
| Old engine couldn't handle the screen (one action per step, six-box codes, menus, captcha solving off) | 9 | Linear (3), HubSpot, DocuSign (2), Zoom, Slack, Workday | Replaced by the hosted browser agent |
| Email identity: the `agentmail.to` domain was refused, or no email arrived | 6 | Notion, Miro, Zoho, Asana, Spotify, Cohere | Open: needs an inbox on a domain Composio owns |
| Bot checks the solver couldn't pass | 5 | DocuSign (Arkose Labs), Salesforce (reCAPTCHA scoring), Tavily, Exa, Figma | Open: a person signs up once, or a less suspicious identity |
| Our verification bugs after the app was created | 5 | Mailchimp (identity field), Airtable (PKCE), Slack (wrong workspace), Todoist (2) | Fixed, except Todoist: its API refuses tokens from DCR clients (403), cause not confirmed |
| Our routing and setup bugs | 4 | Okta (no DCR fallback), Typeform (blank DCR error), Slack (old sign-up steps planned again), Spotify (Browserbase out of minutes) | Fixed (the last one was billing) |
| Credential type not supported | 1 | Firecrawl (OAuth issues only public clients, no secret) | Open: prefer the API key in that case |
| Forced device MFA | 1 | Okta (Okta Verify push app only, no authenticator-app option) | A person once |
| Vendor errors | 1 | AssemblyAI ("password expired", then HTTP 500 at sign-in) | |

Patterns: developer and productivity tools with self-serve consoles work (Slack, ClickUp, Zoom, Typeform, Mailchimp). AI APIs that give free credits guard sign-up hard (Tavily, Exa, AssemblyAI, Cohere); of those only Deepgram got through. Every bug found live was fixed in a way that applies to all vendors.

**Hand-driven tests through Browser Use** (from a chat, before the hosted route was built): account and app or key created for Zoom, Linear and the Anthropic Console; Salesforce (twice) stopped at its bot check; a fresh Okta account stopped at Okta Verify.

## What is tested and what isn't

- **Live:** full automation on the hosted browser route, as above. The Composio client (MCP endpoint, bound secrets, live view), the background driver, email resume, PKCE (Airtable, before and after), the DCR fallback and the API-token route (Slack) all ran on the deployed app.
- **Offline only (194 tests):** human in the loop end to end; the old engine's recovery agent; TOTP setup and reuse (live, Okta offered no authenticator-app option, and the agent correctly stopped); DCR with a fetched initial access token; scopes for vendors with none (ClickUp ran live afterwards); the pasted-value handover.
- **Not measured:** cost per run (tokens, searches, Browser Use). Research was cut to one small call; the saving is an estimate.

## Known limits

- **Email identity.** One public-domain inbox is refused or ignored by about a quarter of vendors, and on Asana it would have joined an existing organization for that domain. An inbox on a domain Composio owns is the main fix.
- **Secrets pass through Browser Use.** The client secret, API key or authenticator setup key travels in Browser Use's run result on its way to the vault, so it sits in Browser Use's records. Reading the value off the page with our own code would avoid that; the hosted browser wasn't reachable for that in testing.
- **Captchas.** Browser Use solves them for test accounts by decision; vendor terms and account bans are the risk.
- **Free tier.** Composio's free shared Browser Use account is a limited-time offer and allows two models.
- **Cancel race.** A step already running when a run is cancelled can save over the cancellation.
- **Restricted DCR.** Some "DCR on the main server" vendors accept only trusted (MCP) clients or redirect domains (Typeform, likely Todoist); the run falls back to the console, but the survey counts them as DCR.

## What I'd want to decide with the team before production

- **Whose accounts these are.** Production apps should belong to Composio's legal entity, not an agent inbox. Test credentials are fine under an agent identity; production ones aren't.
- **Bot-farm risk at scale.** Hundreds of sign-ups from one domain and IP range look like abuse. One provider banning the domain could take down working integrations. Some providers' terms forbid automated sign-ups; for those, the API path or a partner program is the answer.
- **Realistic sandboxes.** An empty account isn't enough to test a toolkit. Seed data, the right plan tier and admin roles are often the hard part.
- **Holding credentials is a liability.** A vault full of developer logins and client secrets is a target. That's a security review decision, not just a build.
- **Ops for the human-only tail.** For apps where a person is unavoidable, a small queue with SLAs where the agent does the prep may be cheaper than more automation.
- **Where the use case comes from.** Today it is an optional text box, and runs without it are verified for sign-in only. The factory's toolkit spec (actions and endpoints) is the right input; that needs a decision on how a toolkit spec is handed to this stage.
- **Order of work.** Sort the factory's backlog by strategy (API, browser, human) and start where automation pays off.

## Files

- `lib/provision/types.ts` playbook, step and run shapes
- `lib/provision/playbooks/` Linear (browser), Slack (API), HubSpot (browser, sandbox)
- `lib/provision/planner.ts` playbook lookup, Claude planner for other apps, plan checks
- `lib/provision/engine.ts` the state machine, handoffs, approvals, verification, DCR and Slack handlers, hosted-agent steps
- `lib/provision/hosted.ts` the hosted browser agent: Composio client (MCP or REST), task writing, result parsing
- `lib/provision/sandbox.ts`, `assess.ts`, `dcr.ts`, `scopes.ts` research, credential and route choice, DCR probe, use-case scopes
- `app/api/cron/advance` the background driver
- `lib/provision/recover.ts` the recovery agent: tools, guardrails, Claude and scripted brains
- `lib/provision/browser.ts` Browserbase + Stagehand driver (variables, masked capture, wall detection)
- `lib/provision/vault.ts` Supabase Vault (memory fallback for local dev), redaction
- `lib/provision/inbox.ts`, `totp.ts`, `verify.ts`, `sheets.ts`, `runs.ts`, `mock.ts`
- `app/provision/`, `components/Provision*.tsx` the UI; `app/api/provision/*`, `app/api/oauth/callback` the routes
- `scripts/provision.ts` terminal runner; `supabase/provision.sql` tables and vault functions
