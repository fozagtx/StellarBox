import ConnectFlow from "./connect-flow";

export default async function ConnectPage({
  searchParams,
}: {
  searchParams: Promise<{ requestId?: string; clientName?: string }>;
}) {
  const query = await searchParams;
  return (
    <ConnectFlow
      requestId={query.requestId ?? ""}
      clientName={query.clientName ?? ""}
    />
  );
}
