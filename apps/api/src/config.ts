export interface ApiConfig {
  apiUrl: string;
  webUrl: string;
  sessionSecret: string;
  port: number;
  vapidPublicKey?: string;
  vapidPrivateKey?: string;
  vapidSubject?: string;
}

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const port = Number(env.API_PORT ?? 4000);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError("API_PORT must be a valid TCP port");
  }
  return {
    apiUrl: env.PUBLIC_API_URL ?? "http://localhost:4000",
    webUrl: env.PUBLIC_WEB_URL ?? "http://localhost:3000",
    sessionSecret: env.SESSION_SECRET ?? "",
    port,
    ...(env.VAPID_PUBLIC_KEY ? { vapidPublicKey: env.VAPID_PUBLIC_KEY } : {}),
    ...(env.VAPID_PRIVATE_KEY ? { vapidPrivateKey: env.VAPID_PRIVATE_KEY } : {}),
    ...(env.VAPID_SUBJECT ? { vapidSubject: env.VAPID_SUBJECT } : {}),
  };
}
