# Auto-Poster

AI-powered social media bot that crawls news sites, generates tweets using Google Gemini, and posts them to X (Twitter) automatically.

## Features

- **Multi-site crawling** — RSS, JSON-LD, and HTML parsing (3-tier strategy)
- **Google News topic search** — Search any topic via Google News RSS
- **AI tweet generation** — Google Gemini API with model fallback chain
- **13 languages** — Turkish, English, German, French, Spanish, Italian, Portuguese, Dutch, Arabic, Russian, Japanese, Korean, Chinese
- **Smart URL handling** — Auto-resolves Google News redirect URLs to real article links
- **Freshness filter** — Only shares articles from the last 48 hours
- **Duplicate detection** — Never posts the same article twice
- **Scheduled posting** — Cron-based with configurable times and timezone
- **Web dashboard** — Admin panel with auth, article browser, tweet composer, history, settings
- **Twitter API v2** — OAuth 1.0a posting with detailed error handling

## Quick Start

```bash
# Clone
git clone https://github.com/AInewsflow/auto-poster.git
cd auto-poster

# Install
npm install

# Configure
cp config.example.json config.json
# Edit config.json with your API keys

# Build & Run
npm run build
npm start
```

Open `http://localhost:4000` and login with your admin password.

## Configuration

Copy `config.example.json` to `config.json` and fill in:

| Field | Description |
|-------|-------------|
| `sites` | Array of sites to crawl `{url, name, topics?}` |
| `topics` | General topics for Google News search |
| `schedule.times` | Post times in HH:MM format |
| `schedule.timezone` | IANA timezone (e.g. `Europe/Berlin`) |
| `geminiApiKey` | Google Gemini API key ([get one](https://aistudio.google.com/apikey)) |
| `twitter.*` | Twitter API v2 credentials ([developer portal](https://developer.x.com)) |
| `adminPassword` | Dashboard login password |
| `language` | Tweet language code (`tr`, `en`, `de`, `fr`, etc.) |
| `style` | Tweet style: `mixed`, `summary`, `comment`, or `info` |

## API Keys

### Gemini API (Free)
1. Go to [Google AI Studio](https://aistudio.google.com/apikey)
2. Create an API key
3. Free tier: 1000 requests/day (gemini-2.5-flash-lite)

### Twitter API (Free)
1. Go to [X Developer Portal](https://developer.x.com)
2. Create a project/app
3. Set app permissions to **Read and Write**
4. Generate API Key, API Secret, Access Token, Access Token Secret

## Deployment

### With PM2

```bash
npm run build
pm2 start dist/index.js --name auto-poster
pm2 save
```

### Behind Nginx (subdirectory)

```nginx
location /poster/ {
    proxy_pass http://127.0.0.1:4000/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

## Tech Stack

- **Runtime:** Node.js + TypeScript
- **Web:** Express 5
- **Crawling:** Cheerio (RSS/HTML/JSON-LD parsing)
- **AI:** Google Gemini API (flash-lite models)
- **Twitter:** twitter-api-v2
- **Scheduling:** node-cron

## License

MIT
