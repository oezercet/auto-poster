import * as cron from "node-cron";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { Config } from "./config";
import { crawlSites, searchTopics, Article } from "./crawler";
import { generateTweet, generateTopicTweet } from "./ai-engine";
import { postTweet } from "./twitter";

type Mode = "full" | "dry-run" | "test-crawl" | "test-ai";

interface PostLog {
  url: string;
  tweet: string;
  tweetId: string;
  timestamp: string;
  success: boolean;
  error?: string;
  source?: string; // "site" | "topic"
}

const DATA_DIR = join(__dirname, "..", "data");
const LOG_FILE = join(DATA_DIR, "post-log.json");

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadPostLog(): PostLog[] {
  ensureDataDir();
  if (!existsSync(LOG_FILE)) return [];
  return JSON.parse(readFileSync(LOG_FILE, "utf-8"));
}

function savePostLog(logs: PostLog[]): void {
  ensureDataDir();
  writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));
}

function isAlreadyPosted(url: string): boolean {
  const logs = loadPostLog();
  return logs.some((log) => log.url === url && log.success);
}

export function getPostLogs(): PostLog[] {
  return loadPostLog();
}

export function addPostLog(log: PostLog): void {
  const logs = loadPostLog();
  logs.push(log);
  savePostLog(logs);
}

export async function runPostCycle(config: Config, mode: Mode = "full"): Promise<void> {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`Post dongusu basliyor: ${new Date().toLocaleString("tr-TR")}`);
  if (mode !== "full") console.log(`Mod: ${mode}`);
  console.log("=".repeat(50));

  // Rastgele karar: site makale mi, topic tweet mi?
  const hasTopics = config.topics && config.topics.length > 0;
  const hasSites = config.sites && config.sites.length > 0;
  const useTopicMode = hasTopics && (!hasSites || Math.random() < 0.4); // %40 topic, %60 site

  if (useTopicMode) {
    await runTopicCycle(config, mode);
  } else {
    await runSiteCycle(config, mode);
  }
}

async function runTopicCycle(config: Config, mode: Mode): Promise<void> {
  // Rastgele bir konu sec
  const topic = config.topics[Math.floor(Math.random() * config.topics.length)];
  console.log(`\n[Topic Modu] Konu: "${topic}"`);

  // Google News'den ara
  console.log("\n[1/3] Konuyla ilgili haberler araniyor...");
  const articles = await searchTopics([topic], config.language);

  if (articles.length > 0) {
    // Haberden tweet uret
    const freshArticles = articles.filter((a) => !isAlreadyPosted(a.url));
    if (freshArticles.length > 0) {
      const article = freshArticles[0];
      console.log(`  Makale: "${article.title}" (${article.source})`);

      console.log("\n[2/3] Tweet uretiliyor...");
      let tweetText: string;
      try {
        tweetText = await generateTweet(article, config.geminiApiKey, config.language, config.style);
        console.log(`\n--- Uretilen Tweet ---`);
        console.log(tweetText);
        console.log(`--- (${tweetText.length} karakter) ---\n`);
      } catch (err) {
        console.error("AI hatasi:", (err as Error).message);
        return;
      }

      if (mode === "test-ai" || mode === "dry-run" || mode === "test-crawl") {
        console.log(`[${mode}] Tweet gonderilmedi (test modu).`);
        return;
      }

      await doPost(tweetText, article.url, "topic");
      return;
    }
  }

  // Haber bulunamadiysa sadece konu bazli tweet
  console.log("  Haber bulunamadi, serbest konu tweeti uretiliyor...");
  console.log("\n[2/3] Konu bazli tweet uretiliyor...");
  let tweetText: string;
  try {
    tweetText = await generateTopicTweet(topic, config.geminiApiKey, config.language);
    console.log(`\n--- Uretilen Tweet ---`);
    console.log(tweetText);
    console.log(`--- (${tweetText.length} karakter) ---\n`);
  } catch (err) {
    console.error("AI hatasi:", (err as Error).message);
    return;
  }

  if (mode === "test-ai" || mode === "dry-run" || mode === "test-crawl") {
    console.log(`[${mode}] Tweet gonderilmedi (test modu).`);
    return;
  }

  await doPost(tweetText, `topic:${topic}`, "topic");
}

async function runSiteCycle(config: Config, mode: Mode): Promise<void> {
  console.log("\n[Site Modu]");
  console.log("\n[1/3] Siteler taraniyor...");
  let articles: Article[];
  try {
    articles = await crawlSites(config.sites);
  } catch (err) {
    console.error("Crawler hatasi:", (err as Error).message);
    return;
  }

  if (articles.length === 0) {
    console.log("Hic makale bulunamadi, atlaniyor.");
    return;
  }

  console.log(`\nToplam ${articles.length} makale bulundu:`);
  articles.forEach((a, i) => console.log(`  ${i + 1}. [${a.source}] ${a.title}`));

  if (mode === "test-crawl") {
    console.log("\n[test-crawl] Crawler testi tamamlandi.");
    return;
  }

  const freshArticles = articles.filter((a) => !isAlreadyPosted(a.url));
  if (freshArticles.length === 0) {
    console.log("Tum makaleler daha once paylasilmis, atlaniyor.");
    return;
  }

  const article = freshArticles[Math.floor(Math.random() * Math.min(3, freshArticles.length))];
  console.log(`\nSecilen makale: "${article.title}" (${article.source})`);

  console.log("\n[2/3] Tweet uretiliyor...");
  let tweetText: string;
  try {
    tweetText = await generateTweet(article, config.geminiApiKey, config.language, config.style);
    console.log(`\n--- Uretilen Tweet ---`);
    console.log(tweetText);
    console.log(`--- (${tweetText.length} karakter) ---\n`);
  } catch (err) {
    console.error("AI hatasi:", (err as Error).message);
    return;
  }

  if (mode === "test-ai" || mode === "dry-run") {
    console.log(`[${mode}] Tweet gonderilmedi (test modu).`);
    return;
  }

  await doPost(tweetText, article.url, "site");
}

async function doPost(tweetText: string, url: string, source: string): Promise<void> {
  console.log("[3/3] Tweet gonderiliyor...");
  try {
    const result = await postTweet(tweetText);
    addPostLog({
      url,
      tweet: tweetText,
      tweetId: result.id,
      timestamp: new Date().toISOString(),
      success: true,
      source,
    });
    console.log(`Basarili! Tweet ID: ${result.id}`);
  } catch (err) {
    const errorMsg = (err as Error).message;
    addPostLog({
      url,
      tweet: tweetText,
      tweetId: "",
      timestamp: new Date().toISOString(),
      success: false,
      error: errorMsg,
      source,
    });
    console.error(`Tweet gonderilemedi: ${errorMsg}`);
  }
}

export function startScheduler(config: Config): void {
  const { times, timezone } = config.schedule;

  console.log(`\nZamanlayici baslatildi (timezone: ${timezone})`);
  console.log(`Zamanlar: ${times.join(", ")}`);
  if (config.topics.length > 0) {
    console.log(`Konular: ${config.topics.join(", ")}`);
  }

  for (const time of times) {
    const [hour, minute] = time.split(":");
    const cronExpr = `${minute} ${hour} * * *`;

    cron.schedule(
      cronExpr,
      () => {
        runPostCycle(config).catch((err) => {
          console.error("Post dongusu hatasi:", err);
        });
      },
      { timezone }
    );

    console.log(`  Zamanlanmis: her gun ${time} (${timezone})`);
  }
}
