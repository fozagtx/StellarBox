import {
  ChannelsClient,
  type ChannelsFuncAuthRequest,
  type ChannelsTransactionResponse,
  type ChannelsXdrRequest,
} from "@openzeppelin/relayer-plugin-channels";
import { loadStellarConfig } from "./config.js";

export function createChannelsClient(env: NodeJS.ProcessEnv = process.env): ChannelsClient {
  const apiKey = env.CHANNELS_API_KEY;
  if (!apiKey) {
    throw new Error("CHANNELS_API_KEY is required to submit through Channels");
  }
  const config = loadStellarConfig(env);
  return new ChannelsClient({ baseUrl: config.channelsBaseUrl, apiKey });
}

export function submitSorobanTransaction(
  request: ChannelsFuncAuthRequest,
  client = createChannelsClient()
): Promise<ChannelsTransactionResponse> {
  return client.submitSorobanTransaction(request);
}

export function submitXdrTransaction(
  request: ChannelsXdrRequest,
  client = createChannelsClient()
): Promise<ChannelsTransactionResponse> {
  return client.submitTransaction(request);
}
