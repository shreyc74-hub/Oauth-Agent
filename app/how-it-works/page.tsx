import { allSkills } from "@/lib/agent/skills";
import { RESEARCH_SKILLS } from "@/lib/agent/research";
import { CHAT_SKILLS } from "@/lib/agent/chat";

export const metadata = { title: "How it works · OAuth Readiness Guides" };

const TOOLS: [string, string, string][] = [
  ["web_search", "Research, chat", "Finds official docs, changelogs and secondary sources."],
  ["web_fetch", "Research, chat", "Reads a page. Doesn't run JavaScript."],
  ["render_page", "Research, lookup", "Opens a page in a real browser for portals that only render with JavaScript."],
  ["load_skill", "Research, chat", "Loads a skill's full instructions when the task needs it."],
  ["search_library / read_guide", "Chat", "Reads guides before answering; compares apps."],
  ["identify_vendor", "Chat, lookup", "Works out which vendor a rough name or link means; rough names are confirmed with you."],
  ["propose_research", "Chat", "Offers a Research button for an app with no guide. You start it."],
  ["save_correction", "Chat", "Proposes a correction to a guide. Saved only if you click Approve."],
];

export default function HowItWorks() {
  const skills = allSkills();
  return (
    <main className="wrap">
      <div className="prose">
        <div className="eyebrow">Approach</div>
        <h1>Creating the app is easy. Getting it approved is the project.</h1>
        <p className="lede">An agent builder on Composio can start on a managed OAuth app. They need their own app for branding, extra scopes, dedicated rate limits or private instances. Platform docs explain how to create that app. These guides explain what happens next: which choices can&apos;t be undone, what stays capped until review, how long approval takes, and which steps an agent can do.</p>

        <section>
          <div className="sh"><h2>What we did</h2></div>
          <p>We created real OAuth apps for Slack, Linear, Notion, Gmail (Google) and Confluence (Atlassian), with an AI agent driving the browser and a person approving sign-ins, terms and creation. Each took 4 to 10 minutes. Every attempt found something the docs or existing guides miss:</p>
          <ul className="tight">
            <li><b>Linear</b> apps are private by default. Our first draft said any workspace could connect. Corrected.</li>
            <li><b>Notion</b> defaults to a single-workspace API token, not OAuth, and locks the install scope after creation.</li>
            <li><b>Slack</b> distribution needs no review, but turning it off later uninstalls the app everywhere; history reads are throttled to 1 request a minute until a Marketplace listing.</li>
            <li><b>Gmail</b>: Google&apos;s console states the 100-user cap is counted over the app&apos;s lifetime (we had it from a secondary source). Internal apps need Google Workspace. Uploading a logo alone triggers verification.</li>
            <li><b>Confluence</b>: rotating refresh tokens are mandatory, and sharing needs a personal data declaration that is almost always &quot;Yes&quot; for agents with memory.</li>
          </ul>
        </section>

        <section>
          <div className="sh"><h2>The agent</h2></div>
          <p>One agent loop with two jobs. The model decides which tool to call next; the code sets the goal, the tools, the skills and the permission rules.</p>
          <ul className="tight">
            <li><b>Research</b> (from the search box): checks OAuth support, then reads official docs, the changelog for the last 18 months, secondary sources and Composio&apos;s docs, and streams the guide section by section. A self-check runs before you see it: rule checks in code, then a second model pass that can only lower a claim&apos;s status.</li>
            <li><b>Chat</b> (on every guide and on Ask the agent): answers from the guides with section citations, compares apps, identifies apps that aren&apos;t in the library and offers to research them.</li>
          </ul>
          <h3>Permission rules</h3>
          <ul className="tight">
            <li>Reading, searching and identifying run on their own.</li>
            <li>Every write waits for you: saving a generated guide, replacing one, or saving a correction.</li>
            <li>Research costs time and money, so the agent offers it and you start it.</li>
            <li>The agent never signs in anywhere, creates apps, or handles secrets.</li>
          </ul>
          <h3>Tools</h3>
          <div className="tablewrap"><table>
            <thead><tr><th>Tool</th><th>Used by</th><th>What it does</th></tr></thead>
            <tbody>{TOOLS.map(([t, u, d]) => <tr key={t}><td className="t"><code>{t}</code></td><td>{u}</td><td>{d}</td></tr>)}</tbody>
          </table></div>
          <h3>Skills</h3>
          <p className="small">Skills are folders of instructions in <code>skills/</code>. The agent sees each skill&apos;s one-line description and loads the full text only when the task needs it, so the prompt stays small and the know-how stays editable without touching code.</p>
          <div className="tablewrap"><table>
            <thead><tr><th>Skill</th><th>Loaded by</th><th>When</th></tr></thead>
            <tbody>{skills.map((s) => <tr key={s.name}><td className="t"><code>{s.name}</code></td><td>{[RESEARCH_SKILLS.includes(s.name) && "Research", CHAT_SKILLS.includes(s.name) && "Chat"].filter(Boolean).join(", ") || "Lookup"}</td><td>{s.description}</td></tr>)}</tbody>
          </table></div>
        </section>

        <section>
          <div className="sh"><h2>Decisions</h2></div>
          <ul className="tight">
            <li><b>Two ratings, not one.</b> Ease of creation and ease of approval are different problems. Slack is easy to create and hard to approve.</li>
            <li><b>&quot;Decisions you can&apos;t undo&quot; comes second.</b> Almost every trap we found was a default or a one-way choice at creation.</li>
            <li><b>Hands-on time and waiting time are separate numbers.</b> Two hours of work and two months of waiting plan very differently.</li>
            <li><b>Every step has an owner:</b> Agent, You, or Waiting.</li>
            <li><b>Every key claim carries a status:</b> tested, official docs, secondary source, conflict, or not verified. Generated guides can never claim &quot;tested&quot;.</li>
            <li><b>Library first, generate on request, save on permission.</b></li>
          </ul>
        </section>

        <section>
          <div className="sh"><h2>Limits</h2></div>
          <ul className="tight">
            <li>We did not submit any app for provider review, so review times come from official guidance and vendor reports.</li>
            <li>Composio&apos;s managed-app list did not render in the docs we read, so managed status is &quot;unknown&quot; unless a Composio page confirms it.</li>
            <li>Generated guides depend on what the agent can find in one research pass of about 10 searches and 8 page reads.</li>
            <li>Having the agent create apps in a cloud browser is designed but parked. The attempts above were done with an agent in a browser plus human approvals.</li>
          </ul>
        </section>
      </div>
      <footer className="foot">Guides marked Tested were checked by creating a real app. Generated guides come from the research agent and say how sure they are about each claim.</footer>
    </main>
  );
}
