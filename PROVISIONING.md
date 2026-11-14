# Provisioning agent: app name in, sandbox and working credentials out

Composio's toolkit factory can research an app and generate a production-ready toolkit on its own. Two steps still need a person: getting a sandbox to test the toolkit in, and creating the OAuth app whose credentials the toolkit runs on. This agent is that missing stage.

You type an app name. The agent:

1. Plans from the app's readiness guide (the output of the first assignment).
2. Gets an identity: your sign-in (human in the loop) or its own inbox and password (full automation).
3. Gets a sandbox: a test account or workspace on the provider.
4. Creates the OAuth app with the scopes from the toolkit spec.
5. Puts every secret into a vault. The model never sees a secret.
6. Proves the credentials work: a real authorization on the sandbox, a token exchange, one identity call, and a refresh.
7. Flags what going live needs. Production review is listed as human work, not attempted.

A tracker row per run goes to a Google Sheet: status, sandbox, masked client ID, vault names, who the token works for, and what still needs a person. Never a secret.

**Scope decision.** This covers test credentials. Production approval (Google's verification with demo videos and documents, Slack's marketplace review, HubSpot's listing) is flagged per app with what a person has to submit. Automating those would mean an agent filling legal and security forms on a company's behalf, which it shouldn't.

## Try it

- **Demo mode** (no accounts): `PROVISION_MOCK=1 npm run dev`, open `/provision`. The browser, inbox and provider APIs are simulated; the plans, state machine, pauses, approvals, vault writes, reveal logging and sheet rows are the real code.
- **Real runs:** set the keys in [Setup](#setup), then use `/provision` or the terminal: `npm run provision -- linear` (add `--auto` for full automation).
- **Tests:** `npm test` (111 tests; 23 for provisioning and the recovery agent, all offline).

## How an app gets its OAuth app: three strategies

Browser automation is the fallback, not the strategy.

| Strategy | When | Example in this build |
|---|---|---|
| **API** | The provider lets you create apps through an API | Slack: `apps.manifest.create` returns the client ID and secret in the response. The only browser work is a one-time bootstrap of an app configuration token, kept fresh with `tooling.tokens.rotate` and reused by every later run. |
| **Browser** | No API, but a stable console | Linear: no API for OAuth apps, so the agent fills the console form. Tested by hand on Oct 28 (see `attempts/linear.md`). |
| **Human** | The step needs a person by policy or law | Captchas, phone checks, payment, signing an acceptable-use policy, production review. |

HubSpot sits in between: on the 2025.2+ developer platform apps are projects deployed with the CLI (`hs project upload`). A worker running the CLI with a personal access key is the API path; the browser path in this build is the fallback, and it hands over if HubSpot insists on the CLI. HubSpot is also the one demo provider with a real sandbox: developer test accounts.

Apps without a hand-written playbook are planned by Claude from their guide, checked by code (`validatePlaybook`: https endpoints, secrets only through variables, client ID and secret captured, a verify step, no agent identity in human mode) and marked **unverified** until a run succeeds. No guide, no plan: the agent sends you to create the guide first.

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
5. Use the refresh token and store the new tokens (refresh tokens can rotate, so the old one may stop working).

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
