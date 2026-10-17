export function serializeApproval<T extends { amount: bigint | null }>(
  approval: T
) {
  return {
    ...approval,
    amount: approval.amount?.toString() ?? null,
  };
}

export function serializeActivity<
  T extends { id: bigint; amount: bigint | null },
>(entry: T) {
  return {
    ...entry,
    id: entry.id.toString(),
    amount: entry.amount?.toString() ?? null,
  };
}
