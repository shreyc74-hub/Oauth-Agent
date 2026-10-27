import { NextResponse } from "next/server";
import { saveCorrection, listCorrections, getGuide } from "@/lib/store";
import { limited } from "@/lib/ratelimit";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const slug = new URL(req.url).searchParams.get("slug") || "";
  return NextResponse.json(slug ? await listCorrections(slug) : []);
}

/** Saves a correction the agent proposed. Only called when the developer clicks Approve. */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const c = {
    slug: String(b.slug || "").slice(0, 60),
    section: String(b.section || "").slice(0, 40),
    claim: String(b.claim || "").trim().slice(0, 600),
    correction: String(b.correction || "").trim().slice(0, 600),
    source: String(b.source || "").slice(0, 300),
  };
  if (!c.slug || !c.claim || !c.correction) return NextResponse.json({ error: "slug, claim and correction are required." }, { status: 400 });
  if (!(await getGuide(c.slug))) return NextResponse.json({ error: `No guide called "${c.slug}".` }, { status: 404 });
  if (limited(req, "corrections", 20)) return NextResponse.json({ error: "Too many corrections. Try later." }, { status: 429 });
  await saveCorrection(c);
  return NextResponse.json({ ok: true });
}
