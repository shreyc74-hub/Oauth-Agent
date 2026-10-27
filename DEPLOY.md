# Deploy checklist

About 20 minutes. Everything below is clicks in GitHub, Supabase and Vercel; no code changes needed.

## 1. GitHub (3 min)

1. Create an empty repository, for example `oauth-readiness-guides` (no README, no .gitignore).
2. In the unzipped project folder:
   ```bash
   git remote add origin https://github.com/<you>/oauth-readiness-guides.git
   git branch -M main
   git push -u origin main
   ```
   The history is already committed. `node_modules` and `.env*` are ignored.

## 2. Supabase (5 min)

1. New project. Any region; note the database password somewhere safe.
2. **SQL Editor** → New query → paste all of `supabase/schema.sql` → Run. This creates `guides` and `corrections`, both with row level security on and no public policies (only the server can read and write).
3. New query → paste all of `supabase/seed.sql` → Run. This loads the 8 library guides. It is safe to run again.
4. **Settings → API Keys**: copy the **Project URL** and a **secret key** (`sb_secret_...`). If your project only shows legacy keys, use the `service_role` key. Never use the publishable or anon key here, and never put either key in the browser.

## 3. Vercel (5 min)

1. **Add New → Project** → import the GitHub repo. Framework: Next.js (detected). Leave build settings as they are: `npm run build` bundles the guides and skills first.
2. **Environment Variables** (Production and Preview):
   | Name | Value |
   |---|---|
   | `ANTHROPIC_API_KEY` | your key |
   | `SUPABASE_URL` | Project URL from step 2.4 |
   | `SUPABASE_SERVICE_ROLE_KEY` | secret key from step 2.4 |
   Optional: `GUIDE_MODEL`, `RENDER_PROVIDER`, the limits. See `.env.example`.
3. Deploy.
4. **Settings → Functions**: check the maximum duration allows **300 seconds** (research runs take 2 to 4 minutes). With Fluid compute on, which is the default for new projects, it should. If research stops at about 60 seconds, this is why.

## 4. First checks on the live site (5 min)

Open the site and check, in order:

1. Home shows 8 guides; the filters work.
2. Type `Slack` → the guide opens instantly (no model call).
3. On the Slack guide, click a suggested question in the chat → an answer with section links. **This is the first real API call**: if it fails, the error text says why (wrong key, model name, credit).
4. Type `monday` → "Which app do you mean?"
5. Type `https://calendly.com` → "There's no guide for Calendly yet" → **Research Calendly**. Watch the steps, then **Save to library**. Reload the home page: it's under "Created by the agent". That proves Supabase writes.
6. Optional automated smoke test from your laptop:
   ```bash
   npm install && npm i -D playwright && npx playwright install chromium
   E2E_URL=https://<your-app>.vercel.app npm run e2e
   E2E_URL=https://<your-app>.vercel.app E2E_RESEARCH=Zoom npm run e2e   # includes one real research run
   ```

## If something fails

| Symptom | Likely cause | Fix |
|---|---|---|
| Chat or research says `Claude API error 401` | Key missing or wrong | Re-check `ANTHROPIC_API_KEY`, redeploy |
| `Claude API error 400` mentioning a model | Model name not available on your account | Set `GUIDE_MODEL` to a model you have, redeploy |
| `Claude API error 400` mentioning a tool | Web search or fetch not enabled for your organization | Enable web search in the Claude Console (admin setting), or ask me to switch tool versions |
| Research stops after about 60 s | Function duration limit | Step 3.4 |
| Saved guide vanishes after redeploy | Supabase variables not set, so it used memory | Step 3.2 |
| `Could not save ... permission denied` | Publishable or anon key used | Use the secret or `service_role` key |
| "The agent isn't configured" | `ANTHROPIC_API_KEY` not set for this environment | Set it for Production and Preview |

## After the interview

Delete the test apps named "OAuth Readiness Test": Slack (Test workspace), Linear, Notion, Google Cloud project `oauth-readiness-test-512919`, Atlassian developer console.
