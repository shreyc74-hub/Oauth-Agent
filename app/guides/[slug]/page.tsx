import { notFound } from "next/navigation";
import { getGuide, listGuides, listCorrections } from "@/lib/store";
import GuidePage from "@/components/GuidePage";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props) {
  const { slug } = await params;
  const g = await getGuide(slug);
  return { title: g ? `${g.name} OAuth Readiness Guide` : "Guide not found", description: g?.verdict };
}

export default async function Page({ params }: Props) {
  const { slug } = await params;
  const g = await getGuide(slug);
  if (!g) notFound();
  const agentOn = Boolean(process.env.ANTHROPIC_API_KEY || process.env.AGENT_MOCK === "1");
  const [all, corrections] = await Promise.all([listGuides(), listCorrections(g.slug).catch(() => [])]);
  const others = all.filter((x) => x.evidenceLevel !== "generated").map((x) => ({ slug: x.slug, name: x.name }));
  return <GuidePage g={g} canRegenerate={agentOn} agentOn={agentOn} others={others} corrections={corrections.length} />;
}
