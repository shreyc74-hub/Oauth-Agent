# OAuth Readiness Guides

**How long until your users can connect?** Guides for agent builders on Composio that cover everything between "I need my own OAuth app" and "any customer can connect": which choices can't be undone, which app type and scopes to pick, what stays capped until review, how long approval takes, and which steps an agent can do versus a person.

A developer opens a guide from the library, or types any app name or link. An agent identifies the vendor, checks the library first, and if there's no guide, researches the vendor's official docs live and streams a new guide in the same 9-section format, with sources for every claim. A chat agent on every guide answers questions with section citations. Nothing is written without the developer's approval.

- **Live app:** _add your Vercel URL_
- **Library preview (Claude artifact):** _add the shared artifact link_
- **Screen designs:** _add the design canvas link_
- **Library:** 8 guides. Tested by creating a real app: Slack, Linear, Notion, Gmail, Confluence. Checked against official docs: HubSpot, Salesforce, LinkedIn.

## Run it

```bash
npm install
cp .env.example .env.local      # add ANTHROPIC_API_KEY; Supabase is optional locally
npm run dev                     # http://localhost:3000
```

No API key? `AGENT_MOCK=1 npm run dev` runs the whole product offline: research replays a library guide through the live streaming screen, and chat gives canned answers that exercise every tool and approval.

Deploying: see [`DEPLOY.md`](DEPLOY.md) (GitHub, Supabase, Vercel, first checks, troubleshooting).

## Tests

```bash
npm test          # 76 unit and edge-case tests, no network needed (a fake Claude API stands in)
npm run typecheck
npm run validate  # every library guide against the schema
npm run e2e       # browser click-through: mock locally, or E2E_URL=https://... for the live site
```

The unit tests cover the agent loop (streaming, `pause_turn` continuation, client tool rounds, tool errors, API and stream errors, the round limit), the stream parser (lines split across chunks, fences, duplicates, forged slugs or "tested" claims), page rendering and URL safety (no internal addresses), vendor lookup (rough names, JavaScript-only links, failures), the self-check, both agents end to end, every API route (validation, library protection, overwrite rules, permission for writes, rate limits, streams), and the UI logic.

## The problem

Composio lets an agent connect to an app through a Composio-managed OAuth app. Developers need their own app when they want their brand on the consent screen, scopes beyond the defaults, their own rate limits, or private instances. Platform docs (Zapier, n8n, ServiceNow, UiPath) explain how to *create* that app. They don't explain what happens when it has to serve thousands of strangers:

1. **Reviews.** Google restricted scopes need verification plus a paid security assessment every year. Slack Marketplace review takes up to about 12 weeks. LinkedIn page APIs are an application that can be rejected with no reapply.
2. **Limits before review.** Slack throttles history reads to 1 request a minute for unlisted apps, HubSpot stops at 25 installs, Google stops at 100 users over the app's lifetime and expires test tokens after 7 days.
3. **One-way doors.** Most traps we found were defaults or choices that can't be changed after creation.

## What we did

An agent created real OAuth apps in the browser for **Slack, Linear, Notion, Gmail and Confluence**, with a person signing in and approving creation, terms and policy acceptance. Each took 4 to 10 minutes. Every attempt found something the docs or existing guides miss, and the guides were rewritten from those findings. Logs are in [`attempts/`](attempts/); the summary, corrections and open questions are in [`VERIFICATION.md`](VERIFICATION.md).

## The agent

One agent loop (`lib/agent/claude.ts`) with two jobs. The model decides which tool to call next; the code sets the goal, the tools, the skills, the output format and the permission rules.

**Research** (`lib/agent/research.ts`, `/api/generate`): checks OAuth support, then reads official docs, the changelog for the last 18 months, secondary sources and Composio's docs. It marks progress with stage lines and streams the guide one section at a time as JSON lines (`lib/agent/parse.ts`). A **self-check** (`lib/agent/selfcheck.ts`) runs before the developer sees the save prompt: rule checks in code (no "tested" claims, "official docs" needs a real source, valid owners and links), then a second model pass that can only lower a claim's status or mark a conflict.

**Chat** (`lib/agent/chat.ts`, `/api/chat`): answers from the guides with `[§08 slack]` citations that become links, compares apps by reading their guides, identifies apps that aren't in the library and offers to research them, and proposes corrections when a developer says a claim is wrong.

**Vendor lookup** (`lib/agent/resolve.ts`, `/api/resolve`): exact names and aliases open the library guide with no model call. Rough names ("monday") are always confirmed. Links are fetched server-side; a JavaScript-only page is rendered, and the agent never answers "this site needs JavaScript".

### Tools

| Tool | Used by | What it does |
|---|---|---|
| `web_search`, `web_fetch` | Research, chat | Anthropic server tools (current versions); fetch is capped at 30k tokens a page |
| `render_page` | Research, lookup | Renders JavaScript-only pages (`lib/agent/render.ts`, jina reader by default, Browserless optional). Public URLs only |
| `load_skill` | Research, chat | Loads a skill's full instructions on demand |
| `search_library`, `read_guide` | Chat | Reads guides before answering |
| `identify_vendor` | Chat | Same rules as the lookup |
| `propose_research` | Chat | Shows a Research button. The developer starts it |
| `save_correction` | Chat | Shows an approval card. Saved only if the developer clicks Approve |

### Skills

Skills are folders of instructions in [`skills/`](skills/), in the same format as agent skills elsewhere (`SKILL.md` with a name and a one-line description). The agent's prompt lists each skill's description and it loads the full text only when the task needs it, so the prompt stays small and the know-how can be edited without touching code. They are bundled into the build by `scripts/bundle-content.ts`.

| Skill | When it's loaded |
|---|---|
| `oauth-research` | Always, for research: order of sources, source rules, budget |
| `approval-programs` | Writing approval, limits or one-way doors: the five gate types and what to look for |
| `scope-risk` | Writing the scopes table: use cases, levels, re-consent |
| `credential-handoff` | Rating whether the secret can reach Composio without anyone seeing it |
| `no-oauth` | The vendor seems to offer only API keys or tokens |
| `js-pages` | A page comes back empty or asks for JavaScript |
| `vendor-identification` | Identifying a rough name or link |
| `answering-questions` | Every chat answer: citations, comparisons, hand-offs |

### Permission rules

- Reading, searching, identifying and rendering run on their own.
- Every write waits for the developer: saving a generated guide, replacing one, saving a correction.
- Research costs time and money, so the chat agent offers it and the developer starts it.
- Generated guides are always marked "generated", can't claim "tested" (the server enforces it), and can never replace a library guide.
- The agent never signs in anywhere, creates apps, or handles secrets.

## Key decisions

- **Scope: the path from "app created" to "real users can connect".** Not an OAuth tutorial.
- **One schema** for library guides, agent output, the web page, the PDF and the Markdown export (`lib/schema.ts`). The page shows 9 sections in this order: At a glance, Prerequisites, App types, Creation steps, Scopes, Approval and distribution, Data use and compliance, Common blockers, Sources. Four more (decisions you can't undo, limits before approval, tokens, credential handoff) and the per-claim evidence statuses are still researched and stored, used by the chat and the self-check, but not shown.
- **Two ratings, not one.** Ease of creation and ease of approval are different problems; Slack is easy to create and hard to approve.
- **"Decisions you can't undo" is section 2**, because almost every trap was a default or a one-way choice.
- **Hands-on time and waiting time are separate numbers.**
- **Every step has an owner** (Agent, You, Waiting), based on what we saw: agents fill forms and choose scopes; people sign in, accept terms, verify domains, record videos and pay assessors.
- **Every key claim has a status:** tested, official docs, secondary source, conflict, not verified.
- **Library first, research on request, save on permission.**

## Screens

Built from the approved designs: home with the library table and filters (no review needed, live in under a week, tested only, category); the agent's decision points (confirm a rough name, no guide yet, save / download without saving / discard, no OAuth); the live research view (steps, activity and budget on the left, the guide filling in on the right); the guide page with a section menu, the guide, and chat; and Ask the agent for questions across the library. PDF comes from print styles; Markdown from `lib/markdown.ts`.

## Architecture

| Part | Where |
|---|---|
| Guide schema and validation | `lib/schema.ts` |
| Library guides | `data/guides/*.json` (bundled into `lib/generated/content.ts` at build) |
| Agent loop, tools, skills, parser, self-check | `lib/agent/` |
| Skills | `skills/*/SKILL.md` |
| API | `app/api/{resolve,generate,chat,guides,corrections}` |
| Storage (Supabase, in-memory fallback) | `lib/store.ts`, `supabase/schema.sql`, `supabase/seed.sql` |
| Screens | `app/`, `components/` |
| Artifact preview build | `scripts/build-artifact.ts` |

Stack: Next.js 16.4.1 (App Router), React 19, Supabase, Claude API (`claude-sonnet-5-5` by default). No client-side secrets; the service key is server-only.

## Limitations

- No app was submitted for provider review, so review times come from official guidance and vendor reports.
- Composio's managed-app directory did not render in the docs we read; managed status is "unknown" unless a Composio page confirms it.
- A generated guide depends on one research pass (up to 10 searches and 8 page reads) and the model's judgment. The self-check lowers unsupported claims but can't prove a claim true.
- The build sandbox had no access to api.anthropic.com, so the agent was tested against a fake API that follows the documented streaming format. The first live run is in DEPLOY.md step 4.
- Rate limits are in memory per server instance, so they reset on cold starts.
- Corrections go to a review queue; a person applies them to the guide.
- The Claude artifact is a read-only library preview: artifacts can't call outside APIs.

## Parked for later

- **The agent creates the OAuth app** in a cloud browser, following its own guide's steps: one approval for the whole plan, pausing only for sign-in, terms, CAPTCHAs, anything irreversible or anything different from the plan. Designed (screens 5 to 7 in the design canvas), not built.
- **Credential handoff** straight into a secrets vault or a Composio auth config, so no person or model sees the client secret.
- **Freshness monitor** that re-checks each guide's sources monthly and flags changes.
- **Scope change advisor** that says which users must reconnect and what re-review a new scope triggers.
- **An MCP server** exposing the library and the research agent to coding agents.
