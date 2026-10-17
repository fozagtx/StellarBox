"use client";

import { useParams } from "next/navigation";
import { ActionButton, JsonData } from "../../../../components/json-data";
import { api } from "../../../../lib/api";
import { approveApproval, rejectApproval } from "../../../../lib/kit";

export default function ApprovalDetailPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <main>
      <JsonData key={id} title="Approval" load={() => api.approval(id)} />
      <ActionButton label="Approve with passkey" action={() => approveApproval(id)} />
      <ActionButton label="Reject with passkey" action={() => rejectApproval(id)} />
    </main>
  );
}
