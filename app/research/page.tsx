import { redirect } from "next/navigation";
import ResearchView from "@/components/ResearchView";

export const metadata = { title: "Researching · OAuth Readiness Guides" };
export const dynamic = "force-dynamic";

export default function Page({ searchParams }: { searchParams: { name?: string; website?: string; overwrite?: string } }) {
  const name = String(searchParams.name || "").trim().slice(0, 120);
  if (!name) redirect("/");
  const website = String(searchParams.website || "").trim().slice(0, 200);
  return <ResearchView key={`${name}|${website}`} name={name} website={website} overwrite={searchParams.overwrite === "1"} />;
}
