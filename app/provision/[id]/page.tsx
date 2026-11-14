import ProvisionRun from "@/components/ProvisionRun";

export const metadata = { title: "Provisioning run · OAuth Readiness" };
export const dynamic = "force-dynamic";

export default async function Page(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  return <ProvisionRun id={id} />;
}
