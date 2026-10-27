import { redirect } from "next/navigation";
import ResearchView from "@/components/ResearchView";

export const metadata = { title: "Researching · OAuth Readiness Guides" };
export const dynamic = "force-dynamic";

export default async function Page(props: { searchParams: Promise<{ name?: string; website?: string; overwrite?: string }> }) {
  const searchParams = await props.searchParams;
  const name = String(searchParams.name || "").trim().slice(0, 120);
  if (!name) redirect("/");
  const website = String(searchParams.website || "").trim().slice(0, 200);
  return <ResearchView key={`${name}|${website}`} name={name} website={website} overwrite={searchParams.overwrite === "1"} />;
}
