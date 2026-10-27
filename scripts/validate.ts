// Checks every library guide against the schema rules. Usage: npm run validate
import { libraryGuides } from "../lib/library";
import { validateGuide, SECTION_ORDER } from "../lib/schema";

let bad = 0;
for (const g of libraryGuides()) {
  const problems = validateGuide(g);
  const missing = SECTION_ORDER.filter((k) => k !== "header" && (g as unknown as Record<string, unknown>)[k] === undefined);
  if (missing.length) problems.push("missing sections: " + missing.join(", "));
  if (g.evidenceLevel === "docs" && g.evidence.some((e) => e.status === "tested")) problems.push("docs-only guide claims a tested item");
  console.log(`${problems.length ? "FAIL" : "ok  "} ${g.slug.padEnd(12)} ${problems.join("; ")}`);
  if (problems.length) bad++;
}
process.exit(bad ? 1 : 0);
