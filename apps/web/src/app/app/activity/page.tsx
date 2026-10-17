"use client";

import { api } from "../../../lib/api";
import { ActivityList, type ActivityEntry } from "../../../components/activity-list";
import { Card, EmptyState, ErrorNote, PageHeader, Skeleton, useLoad } from "../../../components/ui";

export default function ActivityPage() {
  const activity = useLoad(api.activity);
  const grants = useLoad(api.grants);
  const names = new Map((grants.data ?? []).map((grant) => [grant.id, grant.name]));
  const entries = (activity.data ?? []) as unknown as ActivityEntry[];
  return (
    <>
      <PageHeader title="Activity" subtitle="Every tool call your agents made, the decision, and the on-chain transaction." />
      <ErrorNote error={activity.error} onRetry={activity.reload} />
      {activity.loading && !activity.data ? (
        <Skeleton className="h-64" />
      ) : entries.length === 0 ? (
        <EmptyState title="No activity yet" body="Tool calls from connected agents appear here as they happen." />
      ) : (
        <Card className="py-2">
          <ActivityList entries={entries} grantNames={names} />
        </Card>
      )}
    </>
  );
}
