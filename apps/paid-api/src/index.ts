import express, { type Request, type Response } from "express";
import { readFile } from "node:fs/promises";
import { x402ResourceServer } from "@x402/core/server";
import { x402Facilitator } from "@x402/core/facilitator";
import {
  x402HTTPResourceServer,
  type HTTPRequestContext,
} from "@x402/core/http";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme as ExactStellarFacilitatorScheme } from "@x402/stellar/exact/facilitator";
import { ExactStellarScheme as ExactStellarServerScheme } from "@x402/stellar/exact/server";
import { loadStellarConfig } from "@stellabox/stellar";

const WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php";
const OPEN_METEO_API = "https://api.open-meteo.com/v1/forecast";
export const MAX_TRANSACTION_FEE_STROOPS = 2_000_000;

type FacilitatorSimulationEvent = {
  event: () => {
    type: () => { name: string };
    body: () => {
      v0: () => {
        topics: () => Array<{
          switch: () => { name: string };
          sym: () => { toString: () => string };
        }>;
      };
    };
  };
};

type SimulationEventValidator = (
  events: FacilitatorSimulationEvent[],
  fromAddress: string,
  toAddress: string,
  expectedAmount: bigint,
  expectedAsset: string
) => unknown;

function allowSmartAccountPolicyEvents(scheme: ExactStellarFacilitatorScheme) {
  const internalScheme = scheme as unknown as {
    validateSimulationEvents: SimulationEventValidator;
  };
  const validateSimulationEvents =
    internalScheme.validateSimulationEvents.bind(scheme);
  internalScheme.validateSimulationEvents = (
    events,
    fromAddress,
    toAddress,
    expectedAmount,
    expectedAsset
  ) => {
    const transferEvents = events.filter((diagnosticEvent) => {
      try {
        const event = diagnosticEvent.event();
        if (event.type().name !== "contract") return true;
        const topic = event.body().v0().topics()[0];
        return (
          topic?.switch().name === "scvSymbol" &&
          topic.sym().toString() === "transfer"
        );
      } catch {
        return true;
      }
    });
    return validateSimulationEvents(
      transferEvents,
      fromAddress,
      toAddress,
      expectedAmount,
      expectedAsset
    );
  };
}

function requestContext(request: Request): HTTPRequestContext {
  const adapter = {
    getHeader: (name: string) => request.get(name) ?? undefined,
    getMethod: () => request.method,
    getPath: () => request.path,
    getUrl: () => `${request.protocol}://${request.get("host")}${request.originalUrl}`,
    getAcceptHeader: () => request.get("accept") ?? "",
    getUserAgent: () => request.get("user-agent") ?? "",
    getQueryParams: () =>
      Object.fromEntries(
        Object.entries(request.query).map(([key, value]) => [
          key,
          Array.isArray(value) ? value.map(String) : String(value ?? ""),
        ])
      ),
    getBody: () => request.body,
  };
  return {
    adapter,
    path: request.path,
    method: request.method,
    paymentHeader:
      request.get("PAYMENT-SIGNATURE") ?? request.get("X-PAYMENT") ?? undefined,
  };
}

async function fetchJson(url: URL) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Upstream returned HTTP ${response.status}`);
  return response.json() as Promise<unknown>;
}

export async function createPaidApiApp() {
  const config = loadStellarConfig();
  const facilitatorSecret = (
    await readFile(
      new URL("../../../.deploy/paid-api-facilitator.secret", import.meta.url),
      "utf8"
    )
  ).trim();
  const facilitatorScheme = new ExactStellarFacilitatorScheme(
    [createEd25519Signer(facilitatorSecret, "stellar:testnet")],
    {
      rpcConfig: { url: config.rpcUrl },
      maxTransactionFeeStroops: MAX_TRANSACTION_FEE_STROOPS,
    }
  );
  allowSmartAccountPolicyEvents(facilitatorScheme);
  const facilitator = new x402Facilitator().register(
    "stellar:testnet",
    facilitatorScheme
  );
  const facilitatorClient = {
    verify: (payload: Parameters<typeof facilitator.verify>[0], requirements: Parameters<typeof facilitator.verify>[1]) =>
      facilitator.verify(payload, requirements),
    settle: (payload: Parameters<typeof facilitator.settle>[0], requirements: Parameters<typeof facilitator.settle>[1]) =>
      facilitator.settle(payload, requirements),
    getSupported: async () => {
      const supported = facilitator.getSupported();
      return {
        ...supported,
        kinds: supported.kinds.map((kind) => ({
          ...kind,
          network: "stellar:testnet" as const,
        })),
      };
    },
  };
  const server = new x402ResourceServer(facilitatorClient)
    .register("stellar:testnet", new ExactStellarServerScheme());
  const x402 = new x402HTTPResourceServer(server, {
    "GET /search": {
      accepts: {
        scheme: "exact",
        network: "stellar:testnet",
        price: "$0.01",
        payTo: config.merchantAddress,
      },
      description: "Wikipedia search results",
      mimeType: "application/json",
      serviceName: "StellaBox paid API",
    },
    "GET /weather": {
      accepts: {
        scheme: "exact",
        network: "stellar:testnet",
        price: "$0.02",
        payTo: config.merchantAddress,
      },
      description: "Current Open-Meteo weather",
      mimeType: "application/json",
      serviceName: "StellaBox paid API",
    },
  });
  await x402.initialize();

  const app = express();
  app.disable("x-powered-by");

  async function handle(
    request: Request,
    response: Response,
    loadBody: () => Promise<unknown>
  ) {
    const context = requestContext(request);
    const result = await x402.processHTTPRequest(context);
    if (result.type === "payment-error") {
      response.status(result.response.status);
      for (const [key, value] of Object.entries(result.response.headers)) {
        response.setHeader(key, value);
      }
      response.send(result.response.body ?? null);
      return;
    }
    if (result.type !== "payment-verified") {
      response.status(402).json({ error: "payment_required" });
      return;
    }
    try {
      const body = await loadBody();
      const settlement = await x402.processSettlement(
        result.paymentPayload,
        result.paymentRequirements,
        result.declaredExtensions,
        { request: context, responseBody: Buffer.from(JSON.stringify(body)) },
        undefined,
        result.beforeHandlerSettlement
      );
      for (const [key, value] of Object.entries(settlement.headers)) {
        response.setHeader(key, value);
      }
      if (!settlement.success) {
        response.status(settlement.response.status);
        response.send(settlement.response.body ?? null);
        return;
      }
      response.json(body);
    } catch (error) {
      response.status(502).json({
        error: "upstream_error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  app.get("/search", async (request, response, next) => {
    try {
      await handle(request, response, async () => {
        const query = String(request.query.q ?? "").trim();
        if (!query || query.length > 200) throw new Error("q must be 1–200 characters");
        const url = new URL(WIKIPEDIA_API);
        url.search = new URLSearchParams({
          action: "query",
          list: "search",
          format: "json",
          origin: "*",
          srsearch: query,
        }).toString();
        return fetchJson(url);
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/weather", async (request, response, next) => {
    try {
      await handle(request, response, async () => {
        const latitude = Number(request.query.lat);
        const longitude = Number(request.query.lon);
        if (
          !Number.isFinite(latitude) ||
          latitude < -90 ||
          latitude > 90 ||
          !Number.isFinite(longitude) ||
          longitude < -180 ||
          longitude > 180
        ) {
          throw new Error("lat and lon must be valid coordinates");
        }
        const url = new URL(OPEN_METEO_API);
        url.search = new URLSearchParams({
          latitude: String(latitude),
          longitude: String(longitude),
          current: "temperature_2m,relative_humidity_2m,wind_speed_10m",
        }).toString();
        return fetchJson(url);
      });
    } catch (error) {
      next(error);
    }
  });

  app.use((error: unknown, _request: Request, response: Response, next: express.NextFunction) => {
    void next;
    response.status(400).json({
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return app;
}

const port = Number(process.env.PAID_API_PORT ?? 4100);
if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  const app = await createPaidApiApp();
  app.listen(port, () => console.log(`StellaBox paid API listening on ${port}`));
}
