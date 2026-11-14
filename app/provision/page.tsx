import ProvisionStart from "@/components/ProvisionStart";
import { mockEnabled } from "@/lib/provision/mock";

export const metadata = { title: "Provision · OAuth Readiness" };
export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <main>
      <div className="wrap">
        <section className="hero">
          <div className="eyebrow">Credential provisioning · the stage between toolkit built and toolkit tested</div>
          <h1>App name in. Sandbox and working credentials out.</h1>
          <p className="lede">The agent reads the app&apos;s readiness guide, gets a test account, creates the OAuth app, puts the secrets in a vault, and proves they work with a real authorization and API call. Anything that needs a person is handed over, not hidden.</p>
          <ProvisionStart mock={mockEnabled()} />
        </section>
        <section className="how">
          <div><b>Plan from the guide</b><p>Each app gets a playbook: API first (Slack&apos;s manifest API), browser when there is no API (Linear), and a person for walls an agent shouldn&apos;t climb.</p></div>
          <div><b>Secrets never touch the model</b><p>Passwords are typed through hidden variables. Client secrets are located while masked, then read by code straight into Supabase Vault.</p></div>
          <div><b>Verified, not just created</b><p>A run is green only after the token exchange, an identity call and a refresh all succeed against the sandbox.</p></div>
          <div><b>Go-live flagged</b><p>Test credentials are automatic. Production review (demo videos, security forms, listings) is listed per app as human work.</p></div>
        </section>
      </div>
    </main>
  );
}
