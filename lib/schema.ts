// The guide schema. One shape for library guides, agent-generated guides, the UI and the exports.
// Sections are numbered to match the guide layout: 0 header, 1 at a glance, 2 one-way doors ... 13 evidence.

export type Owner = "agent" | "you" | "waiting";

/** How sure we are about a claim. */
export type Status =
  | "tested" //      seen in a real setup attempt
  | "docs" //        stated in official provider docs
  | "secondary" //   third-party source (integration vendors, forums)
  | "conflict" //    sources disagree
  | "unverified"; // not checked, or from experience only

export type EvidenceLevel = "tested" | "docs" | "generated";

export interface Note {
  title: string;
  text: string;
  status?: Status;
  tone?: "info" | "warn" | "bad";
}

export interface Guide {
  // 0. Header
  slug: string; //            "slack"
  name: string; //            "Slack"
  website: string; //         "slack.com"
  category: string; //        "Messaging"
  oauth: { supported: boolean; note?: string }; // when false, the rest explains the alternative
  evidenceLevel: EvidenceLevel;
  checkedOn: string; //       ISO date
  verdict: string; //         2-3 sentences, plain English

  // 1. At a glance
  glance: {
    creation: { rating: 1 | 2 | 3 | 4 | 5; label: string; note: string }; // 1 = easiest
    approval: { rating: 1 | 2 | 3 | 4 | 5; label: string; note: string };
    handsOn: { value: string; note: string };
    waiting: { value: string; note: string };
    ownApp: { managedByComposio: "yes" | "no" | "unknown"; headline: string; note: string };
  };

  // 2. Decisions you can't undo
  oneWayDoors: { title: string; detail: string; doThis: string; status: Status }[];

  // 3. App types
  appTypes: {
    items: { name: string; when: string; whoCanInstall: string; review: string; useFor: string; recommended?: boolean }[];
    notes: Note[];
  };

  // 4. Scopes
  scopes: {
    intro: string;
    rows: { useCase: string; scopes: string[]; impact: string; level: "none" | "limited" | "review" | "audit" }[];
    minimalSets: { label: string; scopes: string[]; note: string }[];
    changingLater: string[];
  };

  // 5. Prerequisites
  prerequisites: { toCreate: string[]; forApproval: string[] };

  // 6. Creation steps
  steps: { owner: Owner; title: string; detail: string; time: string }[];
  stepsNote?: string;

  // 7. Approval and distribution
  approval: {
    whenNeeded: string;
    cost: string;
    renewal: string;
    stages: { label: string; duration: string; detail: string }[];
    submit: string[];
    rejections: string[];
    note?: string;
  };

  // 8. Limits before approval
  limits: {
    ladder: { stage: string; works: string; limit: string }[]; // exactly 3: build and test, first customers, scale
    notes: Note[];
  };

  // 9. Tokens
  tokens: { rows: { setting: string; access: string; refresh: string; breaks: string }[]; note?: string };

  // 10. Data use and compliance
  dataUse: { rules: { title: string; text: string }[]; impact?: Note };

  // 11. Credential handoff
  credentialHandoff: { level: 1 | 2 | 3; summary: string; status: Status };

  // 12. Common blockers
  blockers: { symptom: string; cause: string; fix: string; status?: Status }[];

  // 13. Evidence
  evidence: { claim: string; status: Status; basis: string }[];
  sources: { title: string; url: string }[];
}

/** Order in which the agent streams sections. Each streamed line is {"section": key, "data": value}. */
export const SECTION_ORDER = [
  "header",
  "glance",
  "oneWayDoors",
  "appTypes",
  "scopes",
  "prerequisites",
  "steps",
  "approval",
  "limits",
  "tokens",
  "dataUse",
  "credentialHandoff",
  "blockers",
  "evidence",
] as const;
export type SectionKey = (typeof SECTION_ORDER)[number];

export const SECTION_TITLES: Record<string, { num: string; title: string; question: string }> = {
  glance: { num: "01", title: "At a glance", question: "The answer in one screen" },
  oneWayDoors: { num: "02", title: "Decisions you can't undo", question: "Read this before you click anything" },
  appTypes: { num: "03", title: "App types", question: "Which one is right for an agent product?" },
  scopes: { num: "04", title: "Scopes", question: "What each permission costs you" },
  prerequisites: { num: "05", title: "Prerequisites", question: "What to have ready" },
  steps: { num: "06", title: "Creation steps", question: "Who does what, and how long it takes" },
  approval: { num: "07", title: "Approval and distribution", question: "Review, cost and renewal" },
  limits: { num: "08", title: "Limits before approval", question: "What breaks a launch after a demo that worked" },
  tokens: { num: "09", title: "Tokens", question: "What an unattended agent must handle" },
  dataUse: { num: "10", title: "Data use and compliance", question: "Rules that shape agent design" },
  credentialHandoff: { num: "11", title: "Credential handoff", question: "Can the secret reach Composio without anyone seeing it?" },
  blockers: { num: "12", title: "Common blockers", question: "Symptom, cause, fix" },
  evidence: { num: "13", title: "Evidence", question: "How sure we are, and why" },
};

export const STATUS_LABEL: Record<Status, string> = {
  tested: "Tested",
  docs: "Official docs",
  secondary: "Secondary source",
  conflict: "Conflict",
  unverified: "Not verified",
};

export const OWNER_LABEL: Record<Owner, string> = { agent: "Agent", you: "You", waiting: "Waiting" };

export const HANDOFF_LEVELS = {
  1: { name: "Fully automatic", text: "The provider has an API that creates the app and returns credentials to a backend tool, which sends them straight to a Composio auth config. Nobody sees the secret." },
  2: { name: "Browser copy-paste", text: "No creation API. An agent uses the console's copy button and pastes into Composio without reading or screenshotting the value." },
  3: { name: "Human required", text: "The provider forces a human step to reveal the secret (email code, owner role). You paste it into Composio once." },
} as const;

/** Light runtime check used before saving a generated guide. Returns a list of problems. */
export function validateGuide(g: Partial<Guide>): string[] {
  const p: string[] = [];
  const need = (cond: unknown, msg: string) => { if (!cond) p.push(msg); };
  need(g.slug && /^[a-z0-9-]{1,60}$/.test(g.slug), "slug must be lowercase letters, numbers and dashes");
  need(g.name, "name is required");
  need(g.verdict, "verdict is required");
  need(g.oauth && typeof g.oauth.supported === "boolean", "oauth.supported is required");
  if (g.oauth?.supported) {
    need(g.glance?.creation?.rating && g.glance?.approval?.rating, "glance ratings are required");
    need(Array.isArray(g.steps) && g.steps.length >= 3, "at least 3 creation steps");
    need(g.limits?.ladder?.length === 3, "limits.ladder must have 3 stages");
    need(Array.isArray(g.evidence) && g.evidence.length >= 2, "at least 2 evidence lines");
  }
  return p;
}
