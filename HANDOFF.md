# Handoff: provisioning agent (Composio assignment 2)

This is a brief for Claude Code. It covers what is built, what is left, and how to finish it. Shrey is at the dashboard the whole time and does every step marked **[SHREY]**.

## 1. Context

- **Who and why.** Shrey Chaudhary is applying for a PM role (Integrations) at Composio. After the interview on Nov 12, 2026, Composio asked for a second assignment: type an app name, and an agent creates the OAuth app and delivers the credentials. It should work in two modes, human in the loop and fully automated, and be generic rather than tied to particular apps.
- **The real problem.** Composio has a "software factory" that researches an app and generates a production-ready toolkit. Two steps still need a person: a sandbox to test the toolkit in, and creating the app's OAuth credentials. This agent is that missing stage.
- **Scope decision (Shrey's).** Test credentials only. Production approval (Google verification, Slack marketplace review, HubSpot listing) is flagged per app as human work, not attempted.
- **Feedback to address.** The interviewer said he couldn't judge Shrey's integrations knowledge, and that he cares more about the approach than a finished product. `PROVISIONING.md` is the approach document; keep it accurate as things change.
- **The next round** is with Composio's engineering team.
- **Deadline.** Build over the weekend of Nov 14-15, 2026.

**Where things are:**
- Repo: `github.com/shreyc74-hub/Oauth-Agent`
- Branch: **`provisioning-agent`**. Do not merge to `main` without Shrey's explicit OK: `main` is the site already submitted for assignment 1 (`oauth-snowy.vercel.app`).
- Stack: Next.js on Vercel, Supabase (already connected), Anthropic API.
- New pieces: Browserbase with Stagehand v3 (hosted browser), AgentMail (agent inboxes), Supabase Vault (secrets), Google Sheets (tracker).

## 2. What is done

Everything below is on `provisioning-agent`, builds cleanly, and passes `npm test` (111 tests; 23 cover provisioning and recovery, all offline).

**The flow.** App name → plan (playbook) → identity → sign-up or sign-in → sandbox → OAuth app → vault → verify → go-live check.

**Pieces:**

| Piece | File(s) | Notes |
|---|---|---|
| Playbook and run types | `lib/provision/types.ts` | Steps are data: identity, browser, capture, email, totp, api, human, verify, golive |
| Linear playbook | `lib/provision/playbooks/linear.ts` | Browser strategy; console walked by hand in assignment 1 (`attempts/linear.md`) |
| Slack playbook | `lib/provision/playbooks/slack.ts` | API strategy: `apps.manifest.create`, config token kept fresh with `tooling.tokens.rotate`; one-time browser bootstrap of the config token |
| HubSpot playbook | `lib/provision/playbooks/hubspot.ts` | Browser strategy plus a developer test account as the sandbox. **Written from docs only, never run.** |
| Planner | `lib/provision/planner.ts` | Other apps: Claude turns the app's guide into a playbook, checked by `validatePlaybook`, marked unverified. No guide means no plan. |
| Engine | `lib/provision/engine.ts` | Resumable state machine saved after every step; approvals (human mode); handoffs; wall detection; verification; Slack handler; missing setup fails fast |
| Recovery agent | `lib/provision/recover.ts` | When a browser or capture step fails, an agent loop gets the step's goal (look, act, capture to vault, read inbox code, ask human, done), with a budget of 8 actions or 2 minutes. Guardrails are in code. It suggests playbook fixes. |
| Browser driver | `lib/provision/browser.ts` | Browserbase + Stagehand; secrets typed via `%variables%`; masked capture; captcha solving off; per-provider browser context |
| Vault | `lib/provision/vault.ts`, `supabase/provision.sql` | Supabase Vault through two `security definer` functions (service role only); in-memory fallback for local use |
| Inbox, TOTP | `lib/provision/inbox.ts`, `totp.ts` | AgentMail REST; codes and links parsed by code, not the model |
| Verification | `lib/provision/verify.ts`, `app/api/oauth/callback` | Consent on the sandbox, code exchange, identity call, refresh |
| Tracker | `lib/provision/sheets.ts` | Google service account; one row per run; vault names only, never secrets |
| Routes | `app/api/provision/*` | Create, advance, respond, reveal. Real runs need `PROVISION_ACCESS_CODE`; reveals need `PROVISION_ADMIN_TOKEN` and are logged. |
| UI | `app/provision/*`, `components/Provision*.tsx` | Start page, run page with steps, handoff and approval cards, live-browser iframe, credentials, vault list, fixes, audit log |
| Terminal runner | `scripts/provision.ts` | `npm run provision -- linear [--auto]` |
| Demo mode | `lib/provision/mock.ts` | `PROVISION_MOCK=1` simulates the browser, inbox and provider APIs; "Simulate a console change" shows the recovery agent |
| Approach doc | `PROVISIONING.md` | Strategies, modes, credential types, secret handling, workflow vs agent, verification, setup, open product questions |

**Not done: nothing has run against a real provider yet.** Every live integration below is unverified.

## 3. What is pending, in order

### A. Setup for the first live run

| # | Step | Who | How to check it worked |
|---|---|---|---|
| A1 | Create a Browserbase account (free tier). Copy the API key and project ID. | **[SHREY]** signs up and copies the values. Claude Code may open the sign-up page. | Dashboard shows a project |
| A2 | In Supabase (the existing project), SQL editor: run `supabase/provision.sql`. If `create extension ... supabase_vault` errors, Vault is already on: run the rest of the file. | Claude Code pastes the SQL; **[SHREY]** confirms Run | `provision_runs` table exists; `provision_store_secret` and `provision_read_secret` functions exist |
| A3 | Vercel project → Settings → Environment Variables, scope **Preview**: `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`, `PROVISION_ACCESS_CODE`, `PROVISION_ADMIN_TOKEN`. Check that `ANTHROPIC_API_KEY`, `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` include Preview. | **[SHREY]** types every secret value. Claude Code may navigate to the page and fill in the variable names. | Variables listed under Preview |
| A4 | Find the branch's stable preview URL (Vercel → Deployments → `provisioning-agent`; usually `<project>-git-provisioning-agent-<team>.vercel.app`). Set `PUBLIC_BASE_URL` to it, Preview scope. The redirect URI on every created app is `<that URL>/api/oauth/callback`, so it must not change between deploys. | Claude Code | Value saved |
| A5 | Redeploy the latest `provisioning-agent` preview so the new variables load. | Claude Code (needs **[SHREY]**'s OK to click Redeploy) | `/provision` loads and does **not** show the "Demo mode" banner |
| A6 | Function time limit. `app/api/provision/[id]/advance/route.ts` sets `maxDuration = 300` and the engine uses a 250-second budget. If the Vercel plan caps functions lower, lower both (budget about 10 s under the cap) and push. | Claude Code | An advance call doesn't time out (Vercel → Logs) |

### B. First live run: Linear, human in the loop

1. Open `<preview>/provision`, enter the access code **[SHREY]**, type `Linear`, choose **Human in the loop**, start.
2. At "Sign in and finish onboarding", **[SHREY]** signs in to Linear in the live browser. Use the existing test workspace, not a work account. Then press **Done, continue**.
3. At each approval card, read what the agent is about to do. **[SHREY]** approves.
4. Expected end state: status **Verified**, Client ID shown, "Verified as" shows the Linear user name, refresh "ok".
5. Whatever happens, save the run's audit log. Copy the log text or take a screenshot. Note every handoff, recovery-agent action and suggested fix.

**Likely problems and where to fix them:**

| Symptom | Likely cause | Fix in |
|---|---|---|
| Run fails at the first browser step with a Stagehand error | Constructor options (the `model` object, `projectId`) or the model name differ in the installed Stagehand version | `browser.ts` `openBrowser`; try `STAGEHAND_MODEL` |
| Live view is blank | Browserbase live view not embeddable, or debug URL format | `browser.ts` `liveViewUrl`; the "Open live browser" link still works |
| Capture says "empty or still masked" | `locator(...).inputValue/innerText` doesn't fit the element; secret not revealed | `browser.ts` `capture`; the recovery agent should try first; then paste the value via the handoff field |
| Verify: "Token endpoint said 400" | Redirect URI mismatch (`PUBLIC_BASE_URL` wrong) or Linear's token request format | Check A4; `verify.ts` `tokenCall` (`clientAuth`) |
| Verify: no code | Consent click missed, or redirect lands somewhere else | `linear.ts` `consentInstruction`; the callback route stores the code as a backup |
| Advance times out | Function limit | A6 |

**Update the playbook from what actually happened** (button labels, extra dialogs, onboarding screens). Add any useful recovery-agent fix to the playbook. Update `attempts/linear.md` with a short dated "Provisioning run" section: time to working credentials, where the agent needed a person, what changed. Run `npm test`, commit, push.

### C. Slack, human in the loop

- **Prerequisites:** Shrey's Slack sandbox workspace. Test apps named "OAuth Readiness Test" from assignment 1 already exist there.
- **Bootstrap (first run only):** the agent opens `api.slack.com/apps`, generates an app configuration token (an approval card) and captures the token and refresh token into the vault. Watch whether capture works. Slack may show tokens unmasked, which `PROVISIONING.md` already lists as a known limit.
- **Check `apps.manifest.create`:** the request body (`{ manifest: "<json string>" }`, JSON content type). If Slack rejects it, try `application/x-www-form-urlencoded` with `manifest=<json>`. The handler is `HANDLERS.slackManifestCreate` in `engine.ts`.
- **A second Slack run** should skip the four bootstrap steps.
- **Expected end state:** Verified, `auth.test` returns the team name, and refresh "ok" (token rotation is on in the manifest).

### D. Full automation: Linear, then Slack

- **[SHREY]** creates an AgentMail account and API key, then adds `AGENTMAIL_API_KEY` (Preview). Redeploy.
- Run Linear in **Full automation**. The agent signs up with `linear-xxxxxx@agentmail.to`, reads the login code from its inbox, then creates the workspace and app.
- Expect a captcha or similar on sign-up. It should become a handoff; **[SHREY]** clears it in the live browser and presses Continue. That counts as a pass: the agent handing over at a wall is the design. Record which walls appeared.
- **Verify the AgentMail field names:** `inbox_id` and `email` on create, `messages[].message_id` on list, `text`/`html` on get. Fix in `inbox.ts`.

### E. HubSpot (docs-only playbook, highest risk)

- **[SHREY]** needs a HubSpot developer account, signed in during the human-mode run.
- The playbook creates a developer test account, then an app with redirect URL and scopes. HubSpot's 2025.2+ platform may require the CLI (`hs project upload`). If the UI says so, the agent hands over: record that.
- **Decide with Shrey:** keep HubSpot as "browser with a CLI handoff", or add a small `api` step that runs the HubSpot CLI with a personal access key. Building the CLI path is optional for the deadline. Writing down the finding is not optional.
- Update `hubspot.ts` and its `evidence` field (`docs` → `tested` only if a run verifies).

### F. Google Sheet tracker (optional for the deadline)

- **[SHREY]** creates a Google Cloud service account and a JSON key, creates a sheet, and shares it with the service account's email as Editor.
- Add `GOOGLE_SERVICE_ACCOUNT_JSON` (the whole JSON on one line) and `GOOGLE_SHEET_ID`. Redeploy.
- A run adds a row to the `Credentials` tab: status, masked client ID, vault names, who the token is verified as, go-live needs. Check that no secret appears in the sheet.

### G. Submission polish

1. Update `PROVISIONING.md` with live results:
   - which providers ran, and in which modes
   - time to verified credentials
   - every handoff and why
   - what the recovery agent fixed
   - what is still untested
   
   Remove "Not yet run against the live providers" only for providers that actually ran.
2. Record a 2-3 minute demo video. **[SHREY]** records. The suggested story: Linear human in the loop end to end, then a full-automation run hitting a wall and handing over, then the vault and the "secrets never touch the model" point.
3. **[SHREY]** decides whether to merge to `main` or send the branch preview link. If merging, keep assignment 1 working: the Library, research and guide pages must be unchanged.
4. Draft the submission note for Shrey to edit: short, human, **no em dashes**, no AI-sounding phrasing. Lead with the approach, then results, then open questions.
5. After the interview: delete the test apps and test workspaces created in A to F, and revoke the Browserbase, AgentMail and Google keys **[SHREY]**.

## 4. Rules for Claude Code

- **Secrets.** Never put a key, password, client secret or token in chat, logs, commits, screenshots or the sheet. Shrey types every secret value himself, straight into Vercel or Supabase. Never commit `.env*`.
- **Accounts and sign-ins.** Shrey creates accounts, signs in, completes 2FA and accepts terms. Do not type his passwords.
- **Confirm before acting.** Ask Shrey before any create, submit, save, deploy, delete or consent action outside the provisioning app itself (inside it, the run's approval cards are that confirmation).
- **Walls.** Never solve or bypass a captcha, phone check or bot detection. Hand it to Shrey.
- **Branch.** Work on `provisioning-agent`. Run `npm test` (and `npx tsc --noEmit`) before every push. No force-push. No merge to `main` without Shrey's OK.
- **Truthfulness in docs.** Mark anything not run live as untested. Don't upgrade `evidence` without a verified run.
- **Writing for Composio** (docs, notes): plain, human tone, no em dashes.

## 5. Reporting back to Shrey after each section

Report four things:
- what ran and its result (Verified / needs review / failed)
- the audit-log highlights
- what you changed, with commit links
- what needs his decision next
