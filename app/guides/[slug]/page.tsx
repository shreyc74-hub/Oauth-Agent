import { notFound } from "next/navigation";
import { getGuide, listGuides, listCorrections } from "@/lib/store";
import GuidePage from "@/components/GuidePage";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: { slug: string } }) {
  const g = await getGuide(params.slug);
  return { title: g ? `${g.name} OAuth Readiness Guide` : "Guide not found", description: g?.verdict };
}

export default async function Page({ params }: { params: { slug: string } }) {
  const g = await getGuide(params.slug);
  if (!g) notFound();
  const agentOn = Boolean(process.env.ANTHROPIC_API_KEY || process.env.AGENT_MOCK === "1");
  const [all, corrections] = await Promise.all([listGuides(), listCorrections(g.slug).catch(() => [])]);
  const others = all.filter((x) => x.evidenceLevel !== "generated").map((x) => ({ slug: x.slug, name: x.name }));
  return <GuidePage g={g} canRegenerate={agentOn} agentOn={agentOn} others={others} corrections={corrections.length} />;
}
