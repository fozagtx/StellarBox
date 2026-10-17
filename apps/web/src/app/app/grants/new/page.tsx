"use client";

import { useRouter } from "next/navigation";
import { GrantForm } from "../../../../components/grant-form";
import { Card, PageHeader } from "../../../../components/ui";

export default function NewGrantPage() {
  const router = useRouter();
  return (
    <div className="max-w-2xl">
      <PageHeader title="New grant" subtitle="Give an AI agent a budget it can't exceed." />
      <Card>
        <GrantForm defaultName="Research agent" onCreated={(id) => router.push(`/app/grants/${id}`)} />
      </Card>
    </div>
  );
}
