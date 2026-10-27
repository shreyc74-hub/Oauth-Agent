export const metadata = { title: "How it works · OAuth Readiness Guides" };

export default function HowItWorks() {
  return (
    <div className="prose">
      <section className="hero" style={{ paddingTop: 24 }}>
        <div className="eyebrow">Approach</div>
        <h1>Creating the app is easy. Getting it approved is the project.</h1>
        <p className="lede">An agent builder on Composio can start on a managed OAuth app. They need their own app for branding, extra scopes, dedicated rate limits or private instances. Platform docs explain how to create that app. These guides explain what happens next: which choices can't be undone, what stays capped until review, how long approval takes, and which steps an agent can do.</p>
      </section>

      <section>
        <div className="sh"><h2>What we did</h2></div>
        <p>We created real OAuth apps for Slack, Linear, Notion, Gmail (Google) and Confluence (Atlassian), with an AI agent driving the browser and a person approving sign-ins, terms and creation. Each took 4 to 10 minutes. Every attempt found something the docs or existing guides miss:</p>
        <ul className="tight">
          <li><b>Linear</b> apps are private by default. Our first draft said any workspace could connect. Corrected.</li>
          <li><b>Notion</b> defaults to a single-workspace API token, not OAuth, and locks the install scope after creation.</li>
          <li><b>Slack</b> distribution needs no review, but turning it off later uninstalls the app everywhere; history reads are throttled to 1 request a minute until a Marketplace listing.</li>
          <li><b>Gmail</b>: Google's console states the 100-user cap is counted over the app's lifetime (we had it from a secondary source). Internal apps need Google Workspace. Uploading a logo alone triggers verification.</li>
          <li><b>Confluence</b>: rotating refresh tokens are mandatory, and sharing needs a personal data declaration that is almost always "Yes" for agents with memory.</li>
        </ul>
      </section>

      <section>
        <div className="sh"><h2>Decisions</h2></div>
        <ul className="tight">
          <li><b>Two ratings, not one.</b> Ease of creation and ease of approval are different problems. Slack is easy to create and hard to approve.</li>
          <li><b>"Decisions you can't undo" comes second.</b> Almost every trap we found was a default or a one-way choice at creation.</li>
          <li><b>Hands-on time and waiting time are separate numbers.</b> Two hours of work and two months of waiting plan very differently.</li>
          <li><b>Every step has an owner:</b> Agent, You, or Waiting. The boundary comes from what we saw: agents fill forms and pick scopes; people sign in, accept terms, verify domains and record review videos.</li>
          <li><b>Every key claim carries a status:</b> tested, official docs, secondary source, conflict, or not verified. Generated guides can never claim "tested".</li>
          <li><b>Library first, generate on request, save on permission.</b> Nothing is written to the library without the developer clicking save.</li>
        </ul>
      </section>

      <section>
        <div className="sh"><h2>How the agent works</h2></div>
        <ol className="tight">
          <li><b>Identify the vendor.</b> Exact names go straight through. Rough names ("monday") are confirmed. Links are fetched server-side; a JavaScript-only page falls back to the domain, title and a web search.</li>
          <li><b>Library first.</b> Known apps open instantly, with PDF and Markdown downloads.</li>
          <li><b>Check OAuth support,</b> then research live: official docs, the vendor's changelog for the last 18 months, secondary sources, and Composio's docs for managed-app status. Progress is shown as it searches and reads.</li>
          <li><b>Stream the guide</b> into the same 14-section schema, one section at a time.</li>
          <li><b>Ask before saving.</b> Generated guides stay marked "generated" until a person reviews them.</li>
        </ol>
      </section>

      <section>
        <div className="sh"><h2>Limits</h2></div>
        <ul className="tight">
          <li>We did not submit any app for provider review, so review times come from official guidance and vendor reports.</li>
          <li>Composio's managed-app list did not render in the docs we read, so managed status is "unknown" unless a Composio page confirms it.</li>
          <li>Generated guides depend on what the agent can find in one research pass.</li>
          <li>Creating apps with the agent inside this product is designed but parked; the attempts above were done with an agent in a browser plus human approvals.</li>
        </ul>
      </section>
    </div>
  );
}
