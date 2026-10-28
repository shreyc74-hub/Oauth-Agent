// Accepts environment variable names written in any case, with or without underscores,
// e.g. "anthropic_api_Key" or "supabaseurl". Runs once at server start (instrumentation.ts) and
// again on import, so every route and page sees the canonical names.
export const ENV_NAMES = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL",
  "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY",
  "GUIDE_MODEL", "RESOLVE_MODEL",
  "RENDER_PROVIDER", "JINA_API_KEY", "BROWSERLESS_TOKEN", "BROWSERLESS_URL", "NOTIFY_URL",
  "GENERATE_LIMIT_PER_HOUR", "CHAT_LIMIT_PER_HOUR", "RESOLVE_LIMIT_PER_HOUR",
  "AGENT_MOCK", "AGENT_MOCK_FAST",
] as const;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Copies loosely named variables onto their canonical names. Returns the names it filled. */
export function normalizeEnv(env: Record<string, string | undefined> = process.env): string[] {
  const filled: string[] = [];
  const keys = Object.keys(env);
  for (const want of ENV_NAMES) {
    if (env[want]) continue;
    const match = keys.find((k) => k !== want && norm(k) === norm(want) && env[k]);
    if (match) { env[want] = String(env[match]).trim(); filled.push(want); }
  }
  // Supabase also accepts a "secret key" under the name people tend to give it.
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    const alt = keys.find((k) => ["supabasesecretkey", "supabasesecret", "supabasekey"].includes(norm(k)) && env[k]);
    if (alt) { env.SUPABASE_SERVICE_ROLE_KEY = String(env[alt]).trim(); filled.push("SUPABASE_SERVICE_ROLE_KEY"); }
  }
  return filled;
}

normalizeEnv();
