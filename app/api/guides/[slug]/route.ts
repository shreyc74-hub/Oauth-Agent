import { NextResponse } from "next/server";
import { getGuide } from "@/lib/store";
import { toMarkdown } from "@/lib/markdown";

export const runtime = "nodejs";

/** GET /api/guides/slack            -> guide JSON
 *  GET /api/guides/slack?format=md  -> Markdown download */
export async function GET(req: Request, { params }: { params: { slug: string } }) {
  const g = await getGuide(params.slug);
  if (!g) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (new URL(req.url).searchParams.get("format") === "md") {
    return new Response(toMarkdown(g), { headers: { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="${g.slug}-oauth-readiness.md"` } });
  }
  return NextResponse.json(g);
}
