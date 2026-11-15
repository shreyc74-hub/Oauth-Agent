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

## Try it

- **Demo mode** (no accounts): `PROVISION_MOCK=1 npm run dev`, open `/provision`. The browser, inbox and provider APIs are simulated; the plans, state machine, pauses, approvals, vault writes, reveal logging and sheet rows are the real code.
- **Real runs:** set the keys in [Setup](#setup), then use `/provision` or the terminal: `npm run provision -- linear` (add `--auto` for full automation).
- **Tests:** `npm test` (155 tests, all offline, including the sandbox check and use-case scopes).

## How an app gets its OAuth app: three strategies

Browser automation is the fallback, not the strategy.

| Strategy | When | Example in this build |
|---|---|---|
| **API** | The provider lets you create apps through an API | Slack: `apps.manifest.create` returns the client ID and secret in the response. The only browser work is a one-time bootstrap of an app configuration token, kept fresh with `tooling.tokens.rotate` and reused by every later run. |
| **Browser** | No API, but a stable console | Linear: no API for OAuth apps, so the agent fills the console form. Tested by hand on Oct 28 (see `attempts/linear.md`). |
| **Human** | The step needs a person by policy or law | Captchas, phone checks, payment, signing an acceptable-use policy, production review. |

**Choosing the mode last.** Picking human in the loop or full automation before the agent knows the vendor would decide how a person gets involved without knowing what the job is. So a run is created research-first and stops at "Ready to start" with the findings. The agent recommends a mode: full automation when the plan is tested or from the vendor's docs and the agent's inbox is configured, a person when the plan is generated and unverified or a sandbox wasn't confirmed. The person picks and starts.

**One research call, not a guide.** The sandbox check's research also collects what provisioning needs from the vendor's official pages: the sign-up and app-creation pages, the steps in order, the OAuth endpoints and a minimal scope set (or, for an API-key vendor, the header and a test call). Code keeps only well-formed parts. When an app has no guide, the plan is written from this brief, which is not saved to the Library; a full guide is researched only when the brief is missing. That is one research call per new vendor instead of two. The browser agent's per-click decisions run on a small model (`STAGEHAND_MODEL`); research, planning and recovery keep the default.

**Zero touch.** With "Run it end to end without me" (on by default), full automation starts by itself when the research finishes. In full automation a not-confirmed sandbox is logged and tried instead of asked about (a gated verdict still stops the run before anything is created), and the OAuth part counts the guide's self-serve creation steps or a DCR endpoint as evidence when no quote says who may create apps. With `PROVISION_ACCEPT_TERMS=1`, set by the owner, the agent accepts vendor developer terms for test accounts and logs each acceptance; payment, phone, identity and business checks always go to a person. Captchas are handed over once per vendor: the shared mailbox's account and the vendor's saved browser context are reused, so later runs for that vendor don't meet them.

**One mailbox, one login per vendor.** With `PROVISION_INBOX_ID` set, full automation uses that one AgentMail inbox for every run instead of creating an inbox per run. Each vendor gets one password, kept in the vault as a shared secret. The first run for a vendor signs up; once that sign-up is confirmed on the page, the vault records that the account exists, and later runs for that vendor sign in instead (their email steps wait only a minute, since a sign-in often sends no email). Runs only read mail that arrived after their own step started.

**API keys.** When OAuth is partner-only but an API key is self-serve (BambooHR), the vendor is not treated as gated: the plan creates a key in the account's dashboard, a capture step reads it straight into the vault, and verification makes one read-only call with it.

**Looking for an API route first: Dynamic Client Registration.** Some vendors let a client register itself with one API call (RFC 7591). They say so in public metadata: a `registration_endpoint` in `/.well-known/oauth-authorization-server` or `/.well-known/openid-configuration`. MCP servers publish `/.well-known/oauth-protected-resource`, which points at their authorization server, and the MCP authorization spec builds on this kind of registration, so many SaaS MCP servers accept it. Every run probes these documents on the vendor's OAuth hosts, its site, `api.`, `auth.` and `mcp.`, in code and without the model, and shows the result on the run page: offered by the main OAuth server, offered only by the MCP server (whose tokens may only work for MCP), or not offered. A registration endpoint is trusted only over https on the vendor's own domain. The probe only reads. When the vendor's main OAuth server offers it, the plan uses it: one POST to the registration endpoint creates the app (an approval card in human mode), the client secret and registration access token go straight to the vault, and verification authorizes against that server's endpoints. If the endpoint wants an initial access token, the run says so and the browser route is the fallback. Other non-browser routes worth adding per vendor: management APIs (Microsoft Graph applications, Okta, Auth0, Zendesk OAuth clients), vendor CLIs and Terraform providers, and manifest flows where a person clicks once (GitHub App manifests).

HubSpot sits in between: on the 2025.2+ developer platform apps are projects deployed with the CLI (`hs project upload`). A worker running the CLI with a personal access key is the API path; the browser path in this build is the fallback, and it hands over if HubSpot insists on the CLI. HubSpot is also the one demo provider with a real sandbox: developer test accounts.

Apps without a hand-written playbook are planned by Claude from their guide, checked by code (`validatePlaybook`: https endpoints, secrets only through variables, client ID and secret captured, a verify step, no agent identity in human mode) and marked **unverified** until a run succeeds. No guide, no plan: when an app has no guide, the provision page runs the research agent first, saves the guide, then plans from it.

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
| Developer account | You sign in, in the live browser | Agent signs up with its own inbox (AgentMail) and a generated password |
| Email codes and magic links | You | Agent reads its inbox with code (not the model) |
| Authenticator 2FA | You | Agent keeps the TOTP seed in the vault and makes its own codes |
| Creates, submits, consent | Agent, after you approve each one | Agent |
| Captcha, phone/SMS, device approval, payment | You | You (the run pauses with a live-browser link) |

The only difference between the modes is who handles identity and approvals. Walls stay with a person in both. Browserbase's automatic captcha solving is switched off on purpose.

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

The model makes decisions in four places:

| Where | What the model decides | What code still controls |
|---|---|---|
| Planner | The playbook for an app with no hand-written one | Structural checks; plan marked unverified |
| Each browser step | What to click and type on the page (Stagehand) | The step's goal, order and approval point |
| Wall check | Whether a captcha, phone check or similar is showing | What happens next: a handoff |
| **Recovery agent** | How to reach a failed step's goal another way | Tools, budget, allowed sites, approvals, secrets |

**The recovery agent.** When a browser or capture step fails (the console changed, a button moved, a dialog got in the way), the step's goal goes to a short agent loop before a person is asked. It has six tools: look, act, capture (page to vault), read inbox code, ask a human, and done. Code decides what it is allowed to do:

- It never receives a secret. Values go page to vault through capture, it is told only "stored", and anything it reads from the page is redacted against every secret the run holds.
- In human-in-the-loop mode, any create, submit or consent action it attempts stops for approval. The person approves that exact action; the step runs again and the agent may do it.
- A captcha, phone check, device prompt or payment form ends the loop with a handoff.
- It can only navigate to the provider's own sites; anything else is refused or reversed.
- It has 8 actions and 2 minutes. If it gives up, the handoff tells the person what it tried.

When it recovers, it suggests a playbook fix ("the control moved into the sidebar menu"). Fixes are shown on the run for a person to review, not applied automatically. That is how playbooks keep up with consoles that change.

Switch it off with `PROVISION_RECOVERY=0`. In demo mode, tick "Simulate a console change" to watch it work on Linear.

## Verification

A run is **verified** only if all of this works against the sandbox:

1. Open the authorize URL with a random `state`, approve consent in the hosted browser.
2. Read the code from the browser's address bar (checking `state`), or from the callback route as a backup.
3. Exchange the code at the token endpoint. Slack's `ok:false` answers are treated as failures.
4. Call an identity endpoint (Linear `viewer`, Slack `auth.test`, HubSpot account details).
5. If a use case was given: make its read-only test call, which proves the scopes cover what the app will do.
6. Use the refresh token and store the new tokens (refresh tokens can rotate, so the old one may stop working).

Otherwise the run ends as **needs review** with the reason.

## Setup

| What | Why | Env |
|---|---|---|
| Supabase | Runs and the vault. Run `supabase/schema.sql`, then `supabase/provision.sql`. | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |
| Browserbase | Hosted browser with live view | `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID` |
| Anthropic | Stagehand's model and planning | `ANTHROPIC_API_KEY` (optional `STAGEHAND_MODEL`) |
| AgentMail | Agent inboxes, full automation only | `AGENTMAIL_API_KEY` |
| Google service account | Tracker sheet (share the sheet with its email as Editor) | `GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_SHEET_ID` |
| Access (optional) | Lock runs and reveals behind a code; open when unset | `PROVISION_ACCESS_CODE`, `PROVISION_ADMIN_TOKEN` |
| Redirect URI | `<this>/api/oauth/callback` on every app | `PUBLIC_BASE_URL` |

## What is tested and what isn't

- **Tested offline (23 tests):** recovery of a failed browser step and of a failed capture with a fix suggested; no secret in the agent's transcript even when the page shows one; the agent's own writes stopping for approval; walls, budget and give-up ending in a handoff; staying on the provider's sites; both modes end to end for Linear, Slack and HubSpot plans; approvals before every write in human mode and none in auto; captcha handoff and retry of the same step; Slack bootstrap skipped on the second run; pasting a value straight into the vault; cancel; callback state matching; plan checks; secrets absent from run records and sheet rows; TOTP against the RFC 6238 vector; email code and link parsing; access and reveal rules.
- **Not yet run against the live providers.** The Linear and Slack console flows were walked by hand in the first assignment; the HubSpot playbook is from docs. The first live runs will correct instructions the way the first assignment's setup attempts corrected the guides.

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
- `lib/provision/engine.ts` the state machine, handoffs, approvals, verification, Slack handler
- `lib/provision/recover.ts` the recovery agent: tools, guardrails, Claude and scripted brains
- `lib/provision/browser.ts` Browserbase + Stagehand driver (variables, masked capture, wall detection)
- `lib/provision/vault.ts` Supabase Vault (memory fallback for local dev), redaction
- `lib/provision/inbox.ts`, `totp.ts`, `verify.ts`, `sheets.ts`, `runs.ts`, `mock.ts`
- `app/provision/`, `components/Provision*.tsx` the UI; `app/api/provision/*`, `app/api/oauth/callback` the routes
- `scripts/provision.ts` terminal runner; `supabase/provision.sql` tables and vault functions
