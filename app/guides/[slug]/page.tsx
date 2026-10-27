import { notFound } from "next/navigation";
import { getGuide } from "@/lib/store";
import GuidePage from "@/components/GuidePage";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: { slug: string } }) {
  const g = await getGuide(params.slug);
  return { title: g ? `${g.name} OAuth Readiness Guide` : "Guide not found" };
}

export default async function Page({ params }: { params: { slug: string } }) {
  const g = await getGuide(params.slug);
  if (!g) notFound();
  return <GuidePage g={g} canRegenerate={Boolean(process.env.ANTHROPIC_API_KEY || process.env.AGENT_MOCK === "1")} />;
}
