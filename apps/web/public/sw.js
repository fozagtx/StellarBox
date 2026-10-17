self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const approvalId = payload.approvalId;
  const url = approvalId
    ? `/approvals/${encodeURIComponent(approvalId)}`
    : "/app/approvals";
  event.waitUntil(
    self.registration.showNotification("StellaBox approval needed", {
      body: "An agent request is waiting for your review.",
      data: { url },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(
    event.notification.data?.url ?? "/app/approvals",
    self.location.origin
  ).href;
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(async (windowClients) => {
        const existing = windowClients.find(
          (client) => new URL(client.url).origin === self.location.origin
        );
        if (existing) {
          await existing.navigate(target);
          return existing.focus();
        }
        return self.clients.openWindow(target);
      })
  );
});
