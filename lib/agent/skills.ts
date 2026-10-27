// Agent skills: folders of instructions the agent loads on demand (progressive disclosure).
// The system prompt lists each skill's name and one-line description; the agent calls
// load_skill to read the full instructions only when it needs them.
import { SKILL_FILES } from "../generated/content";
import type { ClientTool } from "./claude";

export interface Skill { name: string; description: string; body: string }

export function parseSkill(text: string, fallbackName = ""): Skill {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  const meta: Record<string, string> = {};
  if (m) for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { name: meta.name || fallbackName, description: meta.description || "", body: (m ? m[2] : text).trim() };
}

let cache: Skill[] | null = null;
export function allSkills(): Skill[] {
  if (!cache) cache = SKILL_FILES.map((f) => parseSkill(f.text, f.dir)).filter((s) => s.name);
  return cache;
}

export function getSkill(name: string): Skill | null {
  const n = name.trim().toLowerCase();
  return allSkills().find((s) => s.name === n) ?? null;
}

/** The list the model sees in its system prompt. */
export function skillIndex(names?: string[]): string {
  const list = allSkills().filter((s) => !names || names.includes(s.name));
  return list.map((s) => `- ${s.name}: ${s.description}`).join("\n");
}

export function skillTool(onLoad?: (name: string) => void, allowed?: string[]): ClientTool {
  return {
    name: "load_skill",
    description: "Loads the full instructions of one skill from the skills list. Load a skill before the task it describes.",
    input_schema: { type: "object", properties: { name: { type: "string", description: "Skill name from the list" } }, required: ["name"] },
    run: async (input) => {
      const name = String(input.name || "");
      const s = getSkill(name);
      if (!s || (allowed && !allowed.includes(s.name))) return `No skill called "${name}". Available: ${allSkills().filter((x) => !allowed || allowed.includes(x.name)).map((x) => x.name).join(", ")}`;
      onLoad?.(s.name);
      return `# Skill: ${s.name}\n\n${s.body}`;
    },
  };
}
