import { NextResponse } from "next/server";
import { listGuides, getGuide } from "@/lib/store";
import { libraryGuides, matchLibrary, slugify } from "@/lib/library";
import { identify, type Candidate } from "@/lib/agent/resolve";
import { limited } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Finds a stored guide for a vendor by slug or website. */
async function existing(v: Candidate) {
  const slug = slugify(v.name);
  if (await getGuide(slug)) return slug;
  const host = v.website.toLowerCase();
  const all = await listGuides();
  return all.find((g) => g.website.toLowerCase() === host)?.slug ?? null;
}

export async function POST(req: Request) {
  const { query, confirmed } = (await req.json().catch(() => ({}))) as { query?: string; confirmed?: Candidate };
  const q = String(query || "").trim().slice(0, 300);
  if (!q) return NextResponse.json({ error: "Type an app name or paste a link." }, { status: 400 });

  // A vendor the developer already confirmed.
  if (confirmed?.name) {
    const slug = await existing(confirmed);
    return NextResponse.json(slug ? { kind: "library", slug, name: confirmed.name } : { kind: "new", vendor: confirmed, slug: slugify(confirmed.name) });
  }

  // Library first: exact names, aliases and domains need no model call.
  const hit = matchLibrary(q, libraryGuides());
  if (hit) return NextResponse.json({ kind: "library", slug: hit.slug, name: hit.name });
  const stored = (await listGuides()).find((g) => g.slug === slugify(q) || g.website.toLowerCase() === q.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, ""));
  if (stored) return NextResponse.json({ kind: "library", slug: stored.slug, name: stored.name });

  if (process.env.AGENT_MOCK === "1") {
    // Mock mode for UI testing: rough names ask for confirmation, others resolve directly.
    const base = q.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
    if (!base.includes(".") && base.length <= 7) return NextResponse.json({ kind: "confirm", candidates: [{ name: `${base}.com`, website: `${base}.com`, description: "Mock candidate" }], reason: "Mock: short names are confirmed." });
    const name = base.includes(".") ? base.split(".")[0] : base;
    const vendor = { name: name.charAt(0).toUpperCase() + name.slice(1), website: base.includes(".") ? base : `${base}.com` };
    return NextResponse.json({ kind: "new", vendor, slug: slugify(vendor.name) });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ kind: "notfound", message: `"${q}" isn't in the library, and the research agent isn't configured on this deployment.` });
  }
  if (limited(req, "resolve", Number(process.env.RESOLVE_LIMIT_PER_HOUR || 40))) {
    return NextResponse.json({ error: "Too many lookups from this network. Try again in a few minutes." }, { status: 429 });
  }

  try {
    const r = await identify(q);
    if (r.status === "ambiguous") return NextResponse.json({ kind: "confirm", candidates: r.candidates, reason: r.reason });
    if (r.status === "unknown") return NextResponse.json({ kind: "notfound", message: r.message });
    const slug = await existing(r.vendor);
    if (slug) return NextResponse.json({ kind: "library", slug, name: r.vendor.name });
    return NextResponse.json({ kind: "new", vendor: r.vendor, slug: slugify(r.vendor.name) });
  } catch (e) {
    return NextResponse.json({ error: `Lookup failed: ${(e as Error).message}` }, { status: 502 });
  }
}
