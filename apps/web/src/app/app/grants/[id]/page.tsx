"use client";

import { useParams } from "next/navigation";
import { ActionButton, JsonData } from "../../../../components/json-data";
import { api } from "../../../../lib/api";
import { revokeGrant } from "../../../../lib/kit";

export default function GrantDetailPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <main>
      <JsonData key={id} title="Grant" load={() => api.grant(id)} />
      <ActionButton label="Revoke grant" action={() => revokeGrant(id)} />
    </main>
  );
}
