"use client";

import { api } from "../../../lib/api";
import { GrantCard } from "../../../components/grant-card";
import { Button, EmptyState, ErrorNote, PageHeader, SectionTitle, Skeleton, useLoad } from "../../../components/ui";

export default function GrantsPage() {
  const grants = useLoad(api.grants);
  const all = grants.data ?? [];
  const active = all.filter((grant) => grant.status === "active");
  const inactive = all.filter((grant) => grant.status !== "active");
  return (
    <>
      <PageHeader title="Grants" subtitle="Each grant is a separate agent key with its own on-chain limits." action={<Button href="/app/grants/new">New grant</Button>} />
      <ErrorNote error={grants.error} onRetry={grants.reload} />
      {grants.loading && !grants.data ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
      ) : all.length === 0 ? (
        <EmptyState title="No grants yet" body="Create one, then connect Claude or another MCP client to it." action={<Button href="/app/grants/new">Create a grant</Button>} />
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {active.map((grant) => (
              <GrantCard key={grant.id} grant={grant} />
            ))}
          </div>
          {inactive.length ? (
            <section className="mt-10 opacity-80">
              <SectionTitle>Revoked, expired and pending</SectionTitle>
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {inactive.map((grant) => (
                  <GrantCard key={grant.id} grant={grant} />
                ))}
              </div>
            </section>
          ) : null}
        </>
      )}
    </>
  );
}
