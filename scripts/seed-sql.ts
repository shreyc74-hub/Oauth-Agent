// Prints SQL that upserts the library guides. Usage: npm run seed:sql  (writes supabase/seed.sql)
import { libraryGuides } from "../lib/library";

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const rows = libraryGuides().map(
  (g) => `(${q(g.slug)}, ${q(g.name)}, ${q(g.website)}, ${q(g.evidenceLevel)}, ${q(g.checkedOn)}, ${q(JSON.stringify(g))}::jsonb)`,
);
console.log(`insert into public.guides (slug, name, website, evidence_level, checked_on, data) values\n${rows.join(",\n")}\non conflict (slug) do update set name = excluded.name, website = excluded.website, evidence_level = excluded.evidence_level, checked_on = excluded.checked_on, data = excluded.data, updated_at = now();`);
