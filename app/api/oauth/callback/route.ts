import { attachCode } from "@/lib/provision/runs";

export const runtime = "nodejs";

/**
 * Redirect URI for every app the agent creates. The agent normally reads the code from the browser's
 * address bar; this route is the backup and the page a person sees if they approve consent themselves.
 * The code is stored on the run (it is single-use and expires in minutes) and never shown here.
 */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const code = u.searchParams.get("code");
  const state = u.searchParams.get("state");
  const error = u.searchParams.get("error");
  let msg = "Nothing to do here.";
  if (error) msg = `The provider returned an error: ${error.slice(0, 80)}.`;
  else if (code && state) msg = (await attachCode(state, code)) ? "Authorization received. The agent will finish verification. You can close this tab." : "This authorization doesn't match a running provisioning job.";
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Authorization</title><body style="font-family:system-ui;max-width:520px;margin:15vh auto;padding:0 16px;color:#141824"><h1 style="font-size:20px">OAuth callback</h1><p>${msg}</p></body>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}
