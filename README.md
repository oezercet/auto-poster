# Auto-Poster — AI Social Media Automation Bot

Automated X (Twitter) posting bot powered by Google Gemini AI. Crawls news sites and Google News, generates engaging tweets in 13 languages, and posts them on schedule.

Perfect for content creators, news aggregators, and social media managers who want to automate their X posting workflow.

## Features

- **AI-powered tweet generation** — Google Gemini API creates natural, engaging posts from article summaries
- **Multi-site news crawling** — RSS, JSON-LD, and HTML parsing with 3-tier fallback strategy
- **Google News integration** — Search any topic via Google News RSS feed
- **13 languages supported** — Turkish, English, German, French, Spanish, Italian, Portuguese, Dutch, Arabic, Russian, Japanese, Korean, Chinese
- **Smart URL resolution** — Automatically resolves Google News redirect URLs to real article links for proper link previews
- **48-hour freshness filter** — Only shares recent articles, skips outdated content
- **Duplicate detection** — Tracks posted articles, never shares the same story twice
- **Scheduled posting** — Cron-based automation with configurable times and timezone
- **Web dashboard** — Admin panel with article browser, tweet composer, post history, and settings
- **X API v2 integration** — OAuth 1.0a posting with detailed error handling
- **Security** — Login rate limiting, salted password hashing, security headers, input validation

## Quick Start

```bash
# Clone
git clone https://github.com/oezercet/auto-poster.git
cd auto-poster

# Install dependencies
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
| `sites` | Array of news sites to crawl `{url, name, topics?}` |
| `topics` | General topics for Google News search |
| `schedule.times` | Posting times in HH:MM format |
| `schedule.timezone` | IANA timezone (e.g. `Europe/Berlin`) |
| `geminiApiKey` | Google Gemini API key ([get one free](https://aistudio.google.com/apikey)) |
| `twitter.*` | X (Twitter) API v2 credentials ([developer portal](https://developer.x.com)) |
| `adminPassword` | Dashboard login password |
| `language` | Tweet language code (`tr`, `en`, `de`, `fr`, `es`, `it`, `pt`, `nl`, `ar`, `ru`, `ja`, `ko`, `zh`) |
| `style` | Tweet style: `mixed`, `summary`, `comment`, or `info` |

## API Keys

### Google Gemini API (Free)
1. Go to [Google AI Studio](https://aistudio.google.com/apikey)
2. Create an API key
3. Free tier: 1000 requests/day (gemini-2.5-flash-lite)

### X (Twitter) API (Free)
1. Go to [X Developer Portal](https://developer.x.com)
2. Create a project and app
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

## How It Works

1. **Crawl** — Fetches articles from configured news sites via RSS/HTML/JSON-LD parsing
2. **Filter** — Removes duplicates and articles older than 48 hours
3. **Generate** — Sends article summary to Google Gemini AI to create a tweet
4. **Resolve URLs** — Converts Google News redirect URLs to real article links
5. **Post** — Publishes the tweet to X via API v2

## Tech Stack

- **Runtime:** Node.js + TypeScript
- **Web framework:** Express 5
- **News crawling:** Cheerio (RSS, HTML, JSON-LD parsing)
- **AI:** Google Gemini API (flash-lite models with fallback chain)
- **Social media:** twitter-api-v2 (X API v2, OAuth 1.0a)
- **Scheduling:** node-cron

## Security

- Login rate limiting (5 attempts per 15 minutes)
- Salted password hashing
- Security headers (X-Content-Type-Options, X-Frame-Options, X-XSS-Protection)
- Input validation and sanitization
- HttpOnly session cookies

## License

MIT
