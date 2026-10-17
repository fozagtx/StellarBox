import { redirect } from "next/navigation";

export default async function ApprovalNotificationRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/app/approvals/${encodeURIComponent(id)}`);
}
