import { NextResponse } from "next/server";
import { listGuides, getGuide, saveGuide } from "@/lib/store";
import { libraryGuides } from "@/lib/library";
import { validateGuide, type Guide } from "@/lib/schema";
import { limited } from "@/lib/ratelimit";
import { notify } from "@/lib/notify";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(await listGuides());
}

/** Saves a generated guide. Called only after the developer clicks "Save to library". */
export async function POST(req: Request) {
  const { guide, overwrite } = (await req.json().catch(() => ({}))) as { guide?: Guide; overwrite?: boolean };
  if (!guide) return NextResponse.json({ error: "No guide to save." }, { status: 400 });
  if (limited(req, "save", 20)) return NextResponse.json({ error: "Too many saves. Try later." }, { status: 429 });

  const problems = validateGuide(guide);
  if (problems.length) return NextResponse.json({ error: "Guide is incomplete: " + problems.join("; ") }, { status: 422 });

  // Generated guides can never overwrite a researched library guide.
  if (libraryGuides().some((g) => g.slug === guide.slug)) {
    return NextResponse.json({ error: `"${guide.slug}" is a researched library guide and can't be replaced by a generated one.` }, { status: 409 });
  }
  const current = await getGuide(guide.slug);
  if (current && !overwrite) return NextResponse.json({ error: "A guide with this name exists. Confirm replacing it." }, { status: 409 });

  const clean: Guide = { ...guide, evidenceLevel: "generated", evidence: (guide.evidence || []).map((e) => ({ ...e, status: e.status === "tested" ? "unverified" : e.status })) };
  try { await saveGuide(clean); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 502 }); }
  await notify("guide_saved", `Guide saved: ${clean.name} (${current ? "replaced" : "new"}) /guides/${clean.slug}`, req);
  return NextResponse.json({ ok: true, slug: clean.slug });
}
