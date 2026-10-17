import { describe, expect, it } from "vitest";
import { loadApiConfig } from "./config.js";

describe("loadApiConfig", () => {
  it("uses Render URLs and PORT when explicit overrides are absent", () => {
    const config = loadApiConfig({
      RENDER_EXTERNAL_URL: "https://api.example.test",
      WEB_HOST: "web.example.test",
      PORT: "8080",
    });

    expect(config.apiUrl).toBe("https://api.example.test");
    expect(config.webUrl).toBe("https://web.example.test");
    expect(config.port).toBe(8080);
  });

  it("preserves explicit public URL and API port overrides", () => {
    const config = loadApiConfig({
      PUBLIC_API_URL: "https://public-api.example.test",
      PUBLIC_WEB_URL: "https://public-web.example.test",
      API_PORT: "4444",
      PORT: "8080",
    });

    expect(config.apiUrl).toBe("https://public-api.example.test");
    expect(config.webUrl).toBe("https://public-web.example.test");
    expect(config.port).toBe(4444);
  });

  it("keeps localhost defaults outside Render", () => {
    const config = loadApiConfig({});

    expect(config.apiUrl).toBe("http://localhost:4000");
    expect(config.webUrl).toBe("http://localhost:3000");
    expect(config.port).toBe(4000);
  });
});
