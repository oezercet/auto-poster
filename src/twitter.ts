import { TwitterApi } from "twitter-api-v2";
import { TwitterConfig } from "./config";

let client: TwitterApi | null = null;

export function initTwitterClient(config: TwitterConfig): void {
  client = new TwitterApi({
    appKey: config.appKey,
    appSecret: config.appSecret,
    accessToken: config.accessToken,
    accessSecret: config.accessSecret,
  });
  console.log("Twitter API client baslatildi");
}

export async function postTweet(text: string): Promise<{ id: string; text: string }> {
  if (!client) {
    throw new Error("Twitter client baslatilmadi! Once initTwitterClient() cagirin.");
  }

  try {
    const rwClient = client.readWrite;
    const result = await rwClient.v2.tweet(text);

    console.log(`Tweet gonderildi! ID: ${result.data.id}`);

    return {
      id: result.data.id,
      text: result.data.text,
    };
  } catch (err: any) {
    // Detayli hata mesaji
    const detail = err?.data?.detail || err?.data?.title || err?.message || "Bilinmeyen hata";
    const errors = err?.data?.errors?.map((e: any) => e.message).join(", ") || "";
    const msg = errors ? `${detail} (${errors})` : detail;
    console.error("Twitter post hatasi:", JSON.stringify(err?.data || err?.message));
    throw new Error(msg);
  }
}

export async function verifyCredentials(): Promise<boolean> {
  if (!client) return false;

  try {
    const me = await client.v2.me();
    console.log(`Twitter hesabi dogrulandi: @${me.data.username}`);
    return true;
  } catch (err) {
    console.error("Twitter kimlik dogrulama hatasi:", (err as Error).message);
    return false;
  }
}
