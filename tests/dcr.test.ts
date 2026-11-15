// Dynamic Client Registration probe: public metadata only, nothing registered, offline here.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { probeDcr, candidateOrigins, registrationFrom, describeDcr, type Fetcher } from "../lib/provision/dcr";
import { createRun, defaultDeps } from "../lib/provision/engine";
import { _resetRuns } from "../lib/provision/runs";
import { _resetVault } from "../lib/provision/vault";

beforeEach(() => { process.env.PROVISION_MOCK = "1"; delete process.env.SUPABASE_URL; delete process.env.GOOGLE_SHEET_ID; _resetRuns(); _resetVault(); });

const plan = (host: string) => ({ oauth: { authorizeUrl: `https://${host}/oauth/authorize`, tokenUrl: `https://api.${host}/oauth/token`, whoami: { url: `https://api.${host}/me`, pick: "id" }, scopes: ["read"], consentInstruction: "", refresh: "no" as const } });
const docs = (m: Record<string, unknown>): Fetcher => async (u) => m[u] ?? null;

test("candidate origins come from the plan's OAuth hosts and the vendor site, including mcp.", () => {
  const o = candidateOrigins(plan("vendor.example"), "vendor.example");
  for (const h of ["https://vendor.example", "https://api.vendor.example", "https://mcp.vendor.example", "https://auth.vendor.example"]) assert.ok(o.includes(h), h);
});

test("the vendor's own OAuth server offers registration", async () => {
  const r = await probeDcr(plan("idp.example"), "idp.example", docs({
    "https://idp.example/.well-known/openid-configuration": { issuer: "https://idp.example", authorization_endpoint: "https://idp.example/oauth/authorize", token_endpoint: "https://idp.example/oauth/token", registration_endpoint: "https://idp.example/oauth/register", scopes_supported: ["openid", "profile"] },
  }));
  assert.equal(r.available, true);
  assert.equal(r.kind, "api");
  assert.equal(r.registrationEndpoint, "https://idp.example/oauth/register");
  assert.match(describeDcr(r), /one API call/);
});

test("only the MCP server offers registration, found through its protected-resource metadata", async () => {
  const r = await probeDcr(plan("saas.example"), "saas.example", docs({
    "https://saas.example/.well-known/oauth-authorization-server": { issuer: "https://saas.example", authorization_endpoint: "https://saas.example/oauth/authorize" },
    "https://mcp.saas.example/.well-known/oauth-protected-resource": { resource: "https://mcp.saas.example", authorization_servers: ["https://mcp.saas.example"] },
    "https://mcp.saas.example/.well-known/oauth-authorization-server": { issuer: "https://mcp.saas.example", authorization_endpoint: "https://mcp.saas.example/authorize", token_endpoint: "https://mcp.saas.example/token", registration_endpoint: "https://mcp.saas.example/register" },
  }));
  assert.equal(r.available, true);
  assert.equal(r.kind, "mcp");
  assert.match(describeDcr(r), /MCP server/);
  assert.ok(r.found.some((f) => f.url.startsWith("https://saas.example") && !f.registration));
});

test("no registration endpoint anywhere: not offered", async () => {
  const r = await probeDcr(plan("plain.example"), "plain.example", docs({
    "https://plain.example/.well-known/openid-configuration": { issuer: "https://plain.example", authorization_endpoint: "https://plain.example/auth" },
  }));
  assert.equal(r.available, false);
  assert.match(describeDcr(r), /Not offered/);
});

test("a registration endpoint on another domain or over http is not trusted", () => {
  assert.equal(registrationFrom({ registration_endpoint: "https://evil.example/register" }, "https://vendor.example/.well-known/openid-configuration"), undefined);
  assert.equal(registrationFrom({ registration_endpoint: "http://vendor.example/register" }, "https://vendor.example/.well-known/openid-configuration"), undefined);
  assert.ok(registrationFrom({ registration_endpoint: "https://auth.vendor.example/register" }, "https://vendor.example/.well-known/openid-configuration"));
});

test("the probe result is stored and logged on the run", async () => {
  const deps = { ...defaultDeps(), dcrFetch: docs({ "https://linear.app/.well-known/oauth-authorization-server": { issuer: "https://linear.app", authorization_endpoint: "https://linear.app/oauth/authorize", registration_endpoint: "https://linear.app/oauth/register" } }) };
  const run = await createRun({ app: "Linear", mode: "human", baseUrl: "https://example.test" }, deps);
  assert.equal(run.dcr?.available, true);
  assert.ok(run.events.some((e) => /Dynamic Client Registration: Offered/.test(e.text)));
});
