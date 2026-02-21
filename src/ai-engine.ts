import { Article, isGoogleNewsUrl, resolveGoogleNewsUrl } from "./crawler";

const STYLES = ["summary", "comment", "info"] as const;
type Style = (typeof STYLES)[number];

// Desteklenen diller
const LANGUAGES: Record<string, string> = {
  tr: "Turkce",
  en: "English",
  de: "Deutsch (Almanca)",
  fr: "Français (Fransizca)",
  es: "Español (Ispanyolca)",
  it: "Italiano (Italyanca)",
  pt: "Português (Portekizce)",
  nl: "Nederlands (Hollandaca)",
  ar: "العربية (Arapca)",
  ru: "Русский (Rusca)",
  ja: "日本語 (Japonca)",
  ko: "한국어 (Korece)",
  zh: "中文 (Cince)",
};

function getLangName(code: string): string {
  return LANGUAGES[code] || code;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
  error?: { message?: string; code?: number };
}

// En yuksek free tier limitli modelden baslayarak sirala
// gemini-2.5-flash-lite: 15 RPM, 1000/gun
// gemini-2.0-flash-lite: 15 RPM, 1000/gun
// gemini-2.0-flash: 10 RPM, 250/gun
const MODELS = ["gemini-2.5-flash-lite", "gemini-2.0-flash-lite", "gemini-2.0-flash"];

async function callGemini(apiKey: string, prompt: string): Promise<GeminiResponse> {
  for (const model of MODELS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.9,
              maxOutputTokens: 300,
              topP: 0.95,
            },
          }),
        });

        if (res.ok) {
          const data = (await res.json()) as GeminiResponse;
          if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
            console.log(`  Model: ${model}`);
            return data;
          }
        }

        if (res.status === 429) {
          console.log(`  ${model} rate limit, ${attempt === 1 ? "tekrar deneniyor..." : "sonraki model..."}`);
          if (attempt === 1) {
            await new Promise((r) => setTimeout(r, 5000));
            continue;
          }
          break; // sonraki modele gec
        }

        if (!res.ok) {
          console.log(`  ${model} hatasi (${res.status}), sonraki model deneniyor...`);
          break;
        }
      } catch (err) {
        console.log(`  ${model} baglanti hatasi: ${(err as Error).message}`);
        break;
      }
    }
  }

  throw new Error("Tum Gemini modelleri basarisiz oldu");
}

export async function generateTweet(
  article: Article,
  apiKey: string,
  language: string,
  style: string
): Promise<string> {
  const chosenStyle = style === "mixed" ? pickRandomStyle() : style;
  console.log(`  Stil: ${chosenStyle}`);

  const prompt = buildPrompt(article, chosenStyle, language);
  const data = await callGemini(apiKey, prompt);

  const parts = data.candidates?.[0]?.content?.parts || [];
  const fullText = parts.map((p) => p.text || "").join("").trim();

  console.log(`  Gemini yanit: "${fullText.slice(0, 100)}..."`);

  if (!fullText) {
    throw new Error("Gemini bos yanit dondurdu");
  }

  // Google News URL ise gercek makale URL'sini bul
  const finalUrl = await resolveGoogleNewsUrl(article);
  return cleanTweet(fullText, finalUrl);
}

// Konu bazli tweet uretme (site olmadan, sadece konuya gore)
export async function generateTopicTweet(
  topic: string,
  apiKey: string,
  language: string
): Promise<string> {
  const lang = getLangName(language);

  const prompt = `${lang} bir tweet yaz. Konu: "${topic}"

Bu konuda bilgilendirici, ilgi cekici ve guncel bir tweet olustur.

KURALLAR:
- Tweet 200-250 karakter arasinda olsun
- MUTLAKA ${lang} yaz
- 2-3 alakali hashtag ekle
- Maximum 1-2 emoji kullan
- SADECE tweet metnini yaz
- Tirnak isareti kullanma
- Dogal, samimi ve bilgili bir ton kullan
- Guncel bilgiler ve trendlerden bahset`;

  const data = await callGemini(apiKey, prompt);
  const parts = data.candidates?.[0]?.content?.parts || [];
  const fullText = parts.map((p) => p.text || "").join("").trim();

  if (!fullText) throw new Error("Gemini bos yanit dondurdu");

  return cleanTweet(fullText, "");
}

function pickRandomStyle(): Style {
  return STYLES[Math.floor(Math.random() * STYLES.length)];
}

function buildPrompt(article: Article, style: string, language: string): string {
  const lang = getLangName(language);

  const styleInstructions: Record<string, string> = {
    summary: `Bu makaleyi kisa ve bilgilendirici bir sekilde ozetle.`,
    comment: `Bu makale hakkinda ilgi cekici bir kisisel yorum yaz. Soru sorabilir veya tartisma baslatabilirsin.`,
    info: `Bu makaleden ilginc bir bilgi veya istatistik cikar ve paylasilan bilgi olarak sun.`,
  };

  const urlNote = `\n- Makale linki tweet sonuna otomatik eklenecek, tweet icinde link verme`;

  return `Asagidaki makale hakkinda bir tweet yaz. MUTLAKA ${lang} yaz.

Makale basligi: ${article.title}
Makale ozeti: ${article.summary || "(ozet yok, sadece basliga gore yaz)"}
Kaynak: ${article.source}

${styleInstructions[style] || styleInstructions.summary}

ONEMLI KURALLAR:
- Tweet 200-250 karakter arasinda olsun
- MUTLAKA ${lang} yaz
- Sona 2-3 hashtag ekle
- Maximum 1-2 emoji kullan
- SADECE tweet metnini yaz, baska aciklama ekleme
- Tirnak isareti kullanma
- Dogal, samimi ve ilgi cekici bir dil kullan${urlNote}`;
}

function cleanTweet(text: string, articleUrl: string): string {
  let tweet = text
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^\*+|\*+$/g, "")
    .trim();

  const lines = tweet.split("\n").filter((l) => l.trim().length > 0);
  tweet = lines.join("\n");

  if (tweet.length > 260) {
    tweet = tweet.slice(0, 257) + "...";
  }

  if (articleUrl) {
    tweet = `${tweet}\n\n${articleUrl}`;
  }

  return tweet;
}
