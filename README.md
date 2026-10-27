# OAuth Readiness Guides

**How long until your users can connect?** Guides that show agent builders on Composio everything between "I need my own OAuth app" and "any customer can connect": which choices can't be undone, which app type and scopes to pick, what stays capped until review, how long approval takes, and which steps an agent can do versus a person.

A developer can open a guide from the library, or type any app name or link. The research agent identifies the vendor, checks the library first, and if there's no guide, researches the vendor's official docs live and streams a new guide in the same format. Nothing is saved without the developer's permission.

- **Live app:** _add your Vercel URL here_
- **Library preview (Claude artifact):** _add the shared artifact link here_
- **Library:** 8 guides. Tested by creating a real app: Slack, Linear, Notion, Gmail, Confluence. Checked against docs: HubSpot, Salesforce, LinkedIn.

## Run it locally

```bash
npm install
cp .env.example .env.local     # add ANTHROPIC_API_KEY; Supabase is optional locally
npm run dev                    # http://localhost:3000
```

No API key? `AGENT_MOCK=1 npm run dev` replays a library guide through the streaming UI, so you can see the whole flow offline.

## Deploy (Vercel + Supabase)

1. **Supabase:** create a project. In the SQL editor run `supabase/schema.sql`, then `supabase/seed.sql` (the 8 library guides).
2. **Vercel:** import the GitHub repo. Set environment variables:
   - `ANTHROPIC_API_KEY` (required for the agent)
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (server-only; without them generated guides are kept in memory and lost on redeploy)
   - optional: `GUIDE_MODEL` (default `claude-sonnet-5-5`), `GENERATE_LIMIT_PER_HOUR` (default 6 per IP)
3. Deploy. The generate route needs up to 300 seconds; on Vercel Hobby the maximum function duration may be lower, so use Pro or Fluid compute for reliable long research runs.

The artifact preview is rebuilt with `SITE_URL=https://your-app.vercel.app npx tsx --tsconfig tsconfig.scripts.json scripts/build-artifact.ts`.

## The problem

Composio lets an agent connect to an app through a Composio-managed OAuth app. Developers need their own app when they want their brand on the consent screen, scopes beyond the defaults, their own rate limits, or private instances. Platform docs (Zapier, n8n, ServiceNow, UiPath) already explain how to *create* that app. What they don't explain is what happens when the app has to serve thousands of strangers:

1. **Reviews.** Google restricted scopes need verification plus a paid security assessment every year. Slack Marketplace review takes up to about 12 weeks. LinkedIn page APIs are an application that can be rejected with no reapply.
2. **Limits before review.** Slack throttles history reads to 1 request a minute, HubSpot stops at 25 installs, Google stops at 100 users for the app's lifetime and expires test tokens after 7 days.
3. **One-way doors.** Most traps we found were defaults or choices that can't be changed after creation.

## What we did

An agent created real OAuth apps in the browser for **Slack, Linear, Notion, Gmail and Confluence**, with a person signing in and approving creation, terms and policy acceptance. Each took 4 to 10 minutes. Every attempt found something the docs or existing guides miss, and the guides were rewritten from those findings. Full logs are in [`attempts/`](attempts/) and the summary is in [`VERIFICATION.md`](VERIFICATION.md).

## Key decisions

- **Scope: the path from "app created" to "real users can connect".** Not an OAuth tutorial.
- **One 14-section schema** for library guides, agent output, the web page, the PDF and the Markdown export (`lib/schema.ts`).
- **Two ratings, not one.** Ease of creation and ease of approval are different problems.
- **"Decisions you can't undo" is section 2**, because almost every trap was a default or a one-way choice.
- **Hands-on time and waiting time are separate.**
- **Every step has an owner** (Agent, You, Waiting), based on what we saw: agents fill forms and choose scopes; people sign in, accept terms, verify domains, record videos and pay assessors.
- **Every key claim has a status:** tested, official docs, secondary source, conflict, not verified. Generated guides can't claim "tested"; the save route enforces it.
- **Agent flow:** identify the vendor (rough names are confirmed, links are investigated server-side), library first, check OAuth support, research official docs then changelogs then secondary sources, stream the guide section by section, and ask before saving.
- **Writes need permission.** Saving or replacing a guide always asks. Generated guides can never overwrite a tested library guide.

## Architecture

| Part | Where |
|---|---|
| Guide schema and validation | `lib/schema.ts` |
| Library guides | `data/guides/*.json` |
| Vendor identification | `lib/agent/resolve.ts`, `app/api/resolve` |
| Research agent (Claude API with web search and web fetch, streamed) | `lib/agent/research.ts`, `lib/agent/claude.ts`, `app/api/generate` |
| Storage (Supabase, in-memory fallback) | `lib/store.ts`, `supabase/` |
| Guide layout (web, print-to-PDF, artifact) | `components/GuideView.tsx` |
| Markdown export | `lib/markdown.ts`, `/api/guides/[slug]?format=md` |
| Artifact preview build | `scripts/build-artifact.ts` |

## Limitations

- No app was submitted for provider review, so review times come from official guidance and vendor reports.
- Composio's managed-app directory did not render in the docs we read; managed status is "unknown" unless a Composio page confirms it.
- The live agent depends on what it finds in one research pass (up to 10 searches and 8 page reads) and on the model's judgment. Every generated guide says how sure it is about each claim, and is marked as generated.
- The rate limiter is in memory, so it resets when a serverless instance restarts.
- The Claude artifact can't call the research API (artifacts block outside requests), so it is a read-only library preview.

## Parked for later

- **Agent creates the OAuth app.** It would follow its own guide's creation steps, ask for one approval of the whole plan, and pause only for sign-in, terms, secrets or anything irreversible. Needs a cloud browser with live hand-off, or provider APIs (Slack's manifest API).
- **Credential handoff** straight into a Composio auth config, so no person or model sees the client secret.
- **Freshness monitor** that re-checks each guide's sources monthly and flags changes (Salesforce changed its rules twice in a year).
- **Scope change advisor** that says which users must reconnect and what re-review a new scope triggers.
