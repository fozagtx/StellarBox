export function mapApiError(error: unknown): {
  status: number;
  body: { error: string };
} {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message === "invalid_consent" ||
    message === "invalid_grant" ||
    message === "invalid_token"
  ) {
    return { status: 400, body: { error: message } };
  }
  return { status: 500, body: { error: "internal_error" } };
}
