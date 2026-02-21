import * as cheerio from "cheerio";
import { SiteConfig } from "./config";

export interface Article {
  title: string;
  summary: string;
  url: string;
  source: string;
  sourceUrl?: string; // Kaynak sitenin ana URL'si (Google News icin)
  publishedAt?: string; // ISO tarih (varsa)
}

// Son 48 saat icindeki makaleleri filtrele
const MAX_AGE_HOURS = 48;

function isRecent(article: Article): boolean {
  if (!article.publishedAt) return true; // Tarih yoksa kabul et (HTML parse'da tarih bulanamayabilir)
  const pubDate = new Date(article.publishedAt).getTime();
  if (isNaN(pubDate)) return true; // Parse edilemezse kabul et
  const ageMs = Date.now() - pubDate;
  return ageMs < MAX_AGE_HOURS * 60 * 60 * 1000;
}

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

export async function crawlSites(sites: SiteConfig[]): Promise<Article[]> {
  const allArticles: Article[] = [];

  for (const site of sites) {
    try {
      console.log(`  Taraniyor: ${site.name} (${site.url})`);
      const articles = await crawlSite(site);

      // Tarih filtresi: sadece son 48 saat
      const recent = articles.filter(isRecent);

      // Site'ye ozel topic filtresi varsa uygula
      const filtered =
        site.topics && site.topics.length > 0
          ? recent.filter((a) => matchesTopics(a, site.topics!))
          : recent;

      allArticles.push(...filtered);
      const topicInfo = site.topics?.length ? ` (filtre: ${site.topics.join(", ")})` : "";
      const ageInfo = articles.length !== recent.length ? ` (${articles.length - recent.length} eski atildi)` : "";
      console.log(`  ${site.name}: ${filtered.length} makale bulundu${topicInfo}${ageInfo}`);
    } catch (err) {
      console.error(`  ${site.name} taraniamadi:`, (err as Error).message);
    }
  }

  return allArticles;
}

// Dil kodu -> Google News parametreleri
const GNEWS_LOCALE: Record<string, { hl: string; gl: string; ceid: string }> = {
  tr: { hl: "tr", gl: "TR", ceid: "TR:tr" },
  en: { hl: "en", gl: "US", ceid: "US:en" },
  de: { hl: "de", gl: "DE", ceid: "DE:de" },
  fr: { hl: "fr", gl: "FR", ceid: "FR:fr" },
  es: { hl: "es", gl: "ES", ceid: "ES:es" },
  it: { hl: "it", gl: "IT", ceid: "IT:it" },
  pt: { hl: "pt-BR", gl: "BR", ceid: "BR:pt-419" },
  nl: { hl: "nl", gl: "NL", ceid: "NL:nl" },
  ar: { hl: "ar", gl: "SA", ceid: "SA:ar" },
  ru: { hl: "ru", gl: "RU", ceid: "RU:ru" },
  ja: { hl: "ja", gl: "JP", ceid: "JP:ja" },
  ko: { hl: "ko", gl: "KR", ceid: "KR:ko" },
  zh: { hl: "zh-Hans", gl: "CN", ceid: "CN:zh-Hans" },
};

// Google News arama ile konu bazli makale bul
export async function searchTopic(topic: string, language: string = "tr"): Promise<Article[]> {
  const locale = GNEWS_LOCALE[language] || GNEWS_LOCALE.tr;
  const query = encodeURIComponent(topic);
  const url = `https://news.google.com/rss/search?q=${query}&hl=${locale.hl}&gl=${locale.gl}&ceid=${locale.ceid}`;

  try {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const articles = parseRSS(await res.text(), "Google News");
    const recent = articles.filter(isRecent);
    if (articles.length !== recent.length) {
      console.log(`    ${articles.length - recent.length} eski haber filtrelendi`);
    }
    return recent;
  } catch (err) {
    console.error(`  Topic arama hatasi (${topic}):`, (err as Error).message);
    return [];
  }
}

export async function searchTopics(topics: string[], language: string = "tr"): Promise<Article[]> {
  const allArticles: Article[] = [];

  for (const topic of topics) {
    console.log(`  Konu araniyor: "${topic}" (${language})`);
    const articles = await searchTopic(topic, language);
    allArticles.push(...articles);
    console.log(`  "${topic}": ${articles.length} sonuc`);
  }

  return allArticles;
}

function matchesTopics(article: Article, topics: string[]): boolean {
  const text = `${article.title} ${article.summary}`.toLowerCase();
  return topics.some((topic) => text.includes(topic.toLowerCase()));
}

// ============================================
// CRAWL STRATEJISI: RSS > JSON-LD > HTML parse
// ============================================

async function crawlSite(site: SiteConfig): Promise<Article[]> {
  // 1. Oncelikle RSS dene
  const rssArticles = await tryRSS(site);
  if (rssArticles.length > 0) {
    console.log(`    (RSS ile ${rssArticles.length} makale bulundu)`);
    return rssArticles.slice(0, 10);
  }

  // 2. HTML sayfayi cek
  const res = await fetch(site.url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  // 3. JSON-LD dene
  const ldArticles = parseJSONLD($, site);
  if (ldArticles.length > 0) {
    console.log(`    (JSON-LD ile ${ldArticles.length} makale bulundu)`);
    return ldArticles.slice(0, 10);
  }

  // 4. HTML parse (fallback)
  const htmlArticles = parseHTML($, site);
  if (htmlArticles.length > 0) {
    console.log(`    (HTML parse ile ${htmlArticles.length} makale bulundu)`);
  }

  // Ozeti bos olanlari zenginlestir
  const enriched = await Promise.all(
    htmlArticles.slice(0, 5).map(async (article) => {
      if (article.summary && article.summary.length > 30) return article;
      try {
        const detail = await fetchArticleDetail(article.url);
        return { ...article, summary: detail };
      } catch {
        return article;
      }
    })
  );

  return enriched;
}

// ---- RSS ----

async function tryRSS(site: SiteConfig): Promise<Article[]> {
  // Yaygin RSS yollarini dene
  const baseUrl = site.url.replace(/\/$/, "");
  const rssPaths = [
    "/rss",
    "/feed",
    "/rss.xml",
    "/feed.xml",
    "/atom.xml",
    "/index.xml",
  ];

  // Site URL'sinde /tr, /en vs varsa onunla da dene
  const urlObj = new URL(site.url);
  const pathParts = urlObj.pathname.split("/").filter(Boolean);
  if (pathParts.length > 0) {
    rssPaths.unshift(`/${pathParts[0]}/rss`);
    rssPaths.unshift(`/${pathParts[0]}/feed`);
  }

  for (const path of rssPaths) {
    try {
      const rssUrl = `${urlObj.origin}${path}`;
      const res = await fetch(rssUrl, {
        headers: { ...HEADERS, Accept: "application/rss+xml, application/xml, text/xml" },
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) continue;

      const contentType = res.headers.get("content-type") || "";
      const text = await res.text();

      // XML mi kontrol et
      if (text.includes("<rss") || text.includes("<feed") || text.includes("<channel") || contentType.includes("xml")) {
        const articles = parseRSS(text, site.name);
        if (articles.length > 0) {
          console.log(`    RSS bulundu: ${rssUrl}`);
          return articles;
        }
      }
    } catch {
      // timeout veya hata, sonraki path'i dene
    }
  }

  // HTML icinden RSS link'i bul
  try {
    const res = await fetch(site.url, { headers: HEADERS });
    if (res.ok) {
      const html = await res.text();
      const $ = cheerio.load(html);
      const rssLink =
        $('link[type="application/rss+xml"]').attr("href") ||
        $('link[type="application/atom+xml"]').attr("href") ||
        "";
      if (rssLink) {
        const fullUrl = rssLink.startsWith("http") ? rssLink : new URL(rssLink, site.url).toString();
        const rssRes = await fetch(fullUrl, { headers: HEADERS, signal: AbortSignal.timeout(5000) });
        if (rssRes.ok) {
          const articles = parseRSS(await rssRes.text(), site.name);
          if (articles.length > 0) {
            console.log(`    RSS bulundu (HTML'den): ${fullUrl}`);
            return articles;
          }
        }
      }
    }
  } catch {
    // skip
  }

  return [];
}

function parseRSS(xml: string, defaultSource: string): Article[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  const articles: Article[] = [];

  $("item, entry").each((_, el) => {
    if (articles.length >= 10) return;

    const title =
      $(el).find("title").first().text().trim();
    const link =
      $(el).find("link").first().text().trim() ||
      $(el).find("link").first().attr("href") ||
      $(el).find("guid").first().text().trim() ||
      "";
    const source =
      $(el).find("source").text().trim() || defaultSource;
    const sourceUrl =
      $(el).find("source").attr("url") || "";
    const desc =
      $(el).find("description").first().text().trim() ||
      $(el).find("summary").first().text().trim() ||
      $(el).find("content\\:encoded").first().text().trim() ||
      "";

    // Tarih bilgisi (RSS: pubDate, Atom: published/updated)
    const pubDateStr =
      $(el).find("pubDate").first().text().trim() ||
      $(el).find("published").first().text().trim() ||
      $(el).find("updated").first().text().trim() ||
      "";
    const publishedAt = pubDateStr ? new Date(pubDateStr).toISOString() : undefined;

    const cleanDesc = desc.replace(/<[^>]+>/g, "").replace(/&[a-z]+;/g, " ").trim();

    if (title && link) {
      articles.push({
        title: title.slice(0, 200),
        summary: cleanDesc.slice(0, 500),
        url: link,
        source,
        sourceUrl: sourceUrl || undefined,
        publishedAt: publishedAt && !publishedAt.includes("Invalid") ? publishedAt : undefined,
      });
    }
  });

  return articles;
}

// Google News URL mi kontrol et
export function isGoogleNewsUrl(url: string): boolean {
  return url.includes("news.google.com/rss/articles/") || url.includes("news.google.com/articles/");
}

// Google News URL'sini gercek makale URL'sine cevir
// Kaynak sitede baslik eslestirmesi yapar
export async function resolveGoogleNewsUrl(article: Article): Promise<string> {
  if (!isGoogleNewsUrl(article.url)) return article.url;
  if (!article.sourceUrl) return article.url;

  try {
    console.log(`  Google News URL cozuluyor: ${article.source} (${article.sourceUrl})`);
    const res = await fetch(article.sourceUrl, {
      headers: HEADERS,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return article.url;

    const html = await res.text();
    const $ = cheerio.load(html);

    // Basliktan onemli kelimeleri cikar (4+ karakter, noktalama temizle)
    const titleWords = article.title
      .replace(/["""''.,;:!?\-–—()[\]{}]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .map((w) => w.toLowerCase());

    if (titleWords.length === 0) return article.url;

    // Sayfadaki tum linkleri tara, baslik kelimesi eslestir
    let bestMatch = { url: "", score: 0 };

    $("a[href]").each((_, el) => {
      const href = $(el).attr("href") || "";
      const text = $(el).text().trim();
      if (text.length < 15 || href.length < 10) return;

      const textLower = text.toLowerCase();
      const matches = titleWords.filter((w) => textLower.includes(w));
      const score = matches.length / titleWords.length; // 0-1 arasi benzerlik

      if (score > bestMatch.score && score >= 0.4) {
        let fullUrl = href.startsWith("http") ? href : new URL(href, article.sourceUrl!).toString();
        bestMatch = { url: fullUrl, score };
      }
    });

    if (bestMatch.url) {
      console.log(`  Gercek URL bulundu (%%%${Math.round(bestMatch.score * 100)} eslesme): ${bestMatch.url}`);
      return bestMatch.url;
    }

    console.log(`  Gercek URL bulunamadi, Google News URL kullanilacak`);
  } catch (err) {
    console.log(`  URL cozme hatasi: ${(err as Error).message}`);
  }

  return article.url;
}

// ---- JSON-LD ----

function parseJSONLD($: cheerio.CheerioAPI, site: SiteConfig): Article[] {
  const articles: Article[] = [];

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).html() || "{}");
      const items =
        data.mainEntity?.itemListElement ||
        data.itemListElement ||
        [];

      for (const item of items) {
        if (articles.length >= 10) break;
        const article = item.item || item;
        const title = article.headline || article.name || "";
        let url = article.url || "";
        const desc = article.description || "";

        if (!title || !url) continue;

        if (!url.startsWith("http")) {
          url = new URL(url, site.url).toString();
        }

        articles.push({
          title: title.slice(0, 200),
          summary: desc.slice(0, 500),
          url,
          source: site.name,
        });
      }
    } catch {
      // JSON parse hatasi, atla
    }
  });

  return articles;
}

// ---- HTML Parse ----

function parseHTML($: cheerio.CheerioAPI, site: SiteConfig): Article[] {
  const articles: Article[] = [];
  const seen = new Set<string>();

  // Tum linkleri topla: h1-h4 icindeki linkler + article icindeki linkler
  const linkSelectors = [
    "article h2 a, article h3 a",
    "h2 a, h3 a, h4 a",
    "article a[href]",
    '[class*="post"] a[href]',
    '[class*="card"] a[href]',
    '[class*="entry"] a[href]',
    '[class*="article"] a[href]',
  ];

  for (const selector of linkSelectors) {
    $(selector).each((_, el) => {
      if (articles.length >= 10) return;

      const $a = $(el);
      const title = $a.text().trim() || $a.attr("title") || "";
      let href = $a.attr("href") || "";

      if (!title || title.length < 10) return;
      // Nav, footer vs linkleri atla
      if ($a.closest("nav, footer, header, [class*=nav], [class*=footer], [class*=menu]").length) return;

      if (href && !href.startsWith("http")) {
        try {
          href = new URL(href, site.url).toString();
        } catch {
          return;
        }
      }

      // Ayni domain mi kontrol et
      try {
        const linkHost = new URL(href).hostname;
        const siteHost = new URL(site.url).hostname;
        if (!linkHost.includes(siteHost.replace("www.", "")) && !siteHost.includes(linkHost.replace("www.", ""))) return;
      } catch {
        return;
      }

      if (!href || seen.has(href)) return;
      // Ana sayfa linki atla
      if (href === site.url || href === site.url + "/") return;
      seen.add(href);

      // Yakin bir paragraf bul (ozet icin)
      const $parent = $a.closest("article, [class*=post], [class*=card], [class*=entry], div");
      const summary = $parent.find("p").first().text().trim() || "";

      articles.push({
        title: title.slice(0, 200),
        summary: summary.slice(0, 500),
        url: href,
        source: site.name,
      });
    });

    if (articles.length >= 5) break;
  }

  return articles;
}

// ---- Makale Detay ----

async function fetchArticleDetail(url: string): Promise<string> {
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return "";

    const html = await res.text();
    const $ = cheerio.load(html);

    const metaDesc =
      $('meta[name="description"]').attr("content") ||
      $('meta[property="og:description"]').attr("content") ||
      "";

    if (metaDesc && metaDesc.length > 50) return metaDesc.slice(0, 500);

    const paragraphs: string[] = [];
    $("article p, .post-body p, .post-content p, .entry-content p, [class*='article'] p, main p").each(
      (_, el) => {
        const text = $(el).text().trim();
        if (text.length > 40 && paragraphs.length < 3) {
          paragraphs.push(text);
        }
      }
    );

    return paragraphs.join(" ").slice(0, 500) || metaDesc;
  } catch {
    return "";
  }
}
