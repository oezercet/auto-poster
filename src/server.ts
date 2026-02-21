import express, { Request, Response, NextFunction } from "express";
import cookieParser from "cookie-parser";
import crypto from "crypto";
import { Config, saveConfig } from "./config";
import { crawlSites, searchTopics, Article } from "./crawler";
import { generateTweet, generateTopicTweet } from "./ai-engine";
import { initTwitterClient, postTweet, verifyCredentials } from "./twitter";
import { runPostCycle, startScheduler, getPostLogs, addPostLog } from "./scheduler";

let config: Config;
let cachedArticles: Article[] = [];
let lastCrawlTime = 0;

const tokens = new Set<string>();

// Login rate limiting: IP bazli brute-force korumasi
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_BLOCK_MS = 15 * 60 * 1000; // 15 dakika

function checkLoginRate(ip: string): boolean {
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (!record || now > record.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_BLOCK_MS });
    return true;
  }
  if (record.count >= MAX_LOGIN_ATTEMPTS) return false;
  record.count++;
  return true;
}

function resetLoginRate(ip: string): void {
  loginAttempts.delete(ip);
}

function generateToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

function hashPassword(pw: string): string {
  const salt = "auto-poster-v1";
  return crypto.createHash("sha256").update(salt + pw).digest("hex");
}

function checkPassword(input: string): boolean {
  // Hem plain text hem hash destekle (migration)
  if (config.adminPassword.length === 64 && /^[a-f0-9]+$/.test(config.adminPassword)) {
    // Onceki saltsiz hash ile de dene (migration)
    const saltedHash = hashPassword(input);
    const unsaltedHash = crypto.createHash("sha256").update(input).digest("hex");
    if (saltedHash === config.adminPassword || unsaltedHash === config.adminPassword) {
      // Saltsiz hash ise migrate et
      if (unsaltedHash === config.adminPassword) {
        config.adminPassword = saltedHash;
        saveConfig(config);
      }
      return true;
    }
    return false;
  }
  return input === config.adminPassword;
}

function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.["auth-token"];
  if (token && tokens.has(token)) {
    next();
    return;
  }
  res.status(401).json({ error: "Yetkisiz erisim" });
}

export function startServer(cfg: Config): void {
  config = cfg;
  const app = express();

  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());

  // --- Security headers ---
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-XSS-Protection", "1; mode=block");
    next();
  });

  // --- Auth ---
  app.post("/api/login", (req: Request, res: Response) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    if (!checkLoginRate(ip)) {
      res.status(429).json({ error: "Cok fazla deneme. 15 dakika bekleyin." });
      return;
    }
    const { password } = req.body;
    if (!password || typeof password !== "string") {
      res.status(400).json({ error: "Sifre gerekli" });
      return;
    }
    if (checkPassword(password)) {
      resetLoginRate(ip);
      const token = generateToken();
      tokens.add(token);
      res.cookie("auth-token", token, {
        httpOnly: true,
        sameSite: "lax",
        secure: true,
        path: "/",
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });
      res.json({ ok: true });
    } else {
      res.status(401).json({ error: "Yanlis sifre" });
    }
  });

  app.post("/api/logout", (req: Request, res: Response) => {
    const token = req.cookies?.["auth-token"];
    if (token) tokens.delete(token);
    res.clearCookie("auth-token");
    res.json({ ok: true });
  });

  app.get("/api/auth-check", (req: Request, res: Response) => {
    const token = req.cookies?.["auth-token"];
    res.json({ authenticated: !!(token && tokens.has(token)) });
  });

  // --- Protected routes ---
  app.use("/api", authMiddleware);

  // Crawl
  app.get("/api/articles", async (_req: Request, res: Response) => {
    try {
      const now = Date.now();
      if (now - lastCrawlTime > 5 * 60 * 1000 || cachedArticles.length === 0) {
        cachedArticles = await crawlSites(config.sites);
        lastCrawlTime = now;
      }
      res.json({ articles: cachedArticles });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/crawl", async (_req: Request, res: Response) => {
    try {
      cachedArticles = await crawlSites(config.sites);
      lastCrawlTime = Date.now();
      res.json({ articles: cachedArticles });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // AI tweet uret
  app.post("/api/generate", async (req: Request, res: Response) => {
    try {
      const { article } = req.body;
      if (!article || typeof article.title !== "string" || typeof article.source !== "string") {
        res.status(400).json({ error: "article (title, source) gerekli" }); return;
      }
      const safeArticle: Article = {
        title: String(article.title).slice(0, 500),
        summary: String(article.summary || "").slice(0, 1000),
        url: String(article.url || ""),
        source: String(article.source).slice(0, 100),
        sourceUrl: article.sourceUrl ? String(article.sourceUrl).slice(0, 500) : undefined,
      };
      const tweet = await generateTweet(safeArticle, config.geminiApiKey, config.language, config.style);
      res.json({ tweet });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Post tweet + log kaydet
  app.post("/api/post-tweet", async (req: Request, res: Response) => {
    try {
      const { text } = req.body;
      if (!text || typeof text !== "string") { res.status(400).json({ error: "text gerekli" }); return; }
      if (text.length > 500) { res.status(400).json({ error: "Tweet cok uzun (max 500)" }); return; }
      const result = await postTweet(text);
      addPostLog({
        url: "manual",
        tweet: text,
        tweetId: result.id,
        timestamp: new Date().toISOString(),
        success: true,
        source: "manual",
      });
      res.json({ ok: true, tweetId: result.id });
    } catch (err) {
      const msg = (err as Error).message;
      addPostLog({
        url: "manual",
        tweet: req.body.text || "",
        tweetId: "",
        timestamp: new Date().toISOString(),
        success: false,
        error: msg,
        source: "manual",
      });
      res.status(500).json({ error: msg });
    }
  });

  // Auto cycle
  app.post("/api/auto-post", async (_req: Request, res: Response) => {
    try {
      await runPostCycle(config, "full");
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Logs
  app.get("/api/logs", (_req: Request, res: Response) => {
    res.json({ logs: getPostLogs() });
  });

  // Config (maskeli)
  app.get("/api/config", (_req: Request, res: Response) => {
    res.json({
      sites: config.sites,
      topics: config.topics,
      schedule: config.schedule,
      language: config.language,
      style: config.style,
      port: config.port,
      twitter: {
        appKey: mask(config.twitter.appKey),
        appSecret: mask(config.twitter.appSecret),
        accessToken: mask(config.twitter.accessToken),
        accessSecret: mask(config.twitter.accessSecret),
      },
      geminiApiKey: mask(config.geminiApiKey),
    });
  });

  app.put("/api/config", (req: Request, res: Response) => {
    try {
      const u = req.body;
      if (u.sites) config.sites = u.sites;
      if (u.topics) config.topics = u.topics;
      if (u.schedule) config.schedule = u.schedule;
      if (u.language) config.language = u.language;
      if (u.style) config.style = u.style;
      saveConfig(config);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // API keyleri guncelle
  app.put("/api/keys", (req: Request, res: Response) => {
    try {
      const { geminiApiKey, twitter } = req.body;
      if (geminiApiKey) config.geminiApiKey = geminiApiKey;
      if (twitter) {
        if (twitter.appKey) config.twitter.appKey = twitter.appKey;
        if (twitter.appSecret) config.twitter.appSecret = twitter.appSecret;
        if (twitter.accessToken) config.twitter.accessToken = twitter.accessToken;
        if (twitter.accessSecret) config.twitter.accessSecret = twitter.accessSecret;
        // X client'i yeniden baslat
        initTwitterClient(config.twitter);
      }
      saveConfig(config);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Sifre degistir
  app.put("/api/change-password", (req: Request, res: Response) => {
    try {
      const { currentPassword, newPassword } = req.body;
      if (!checkPassword(currentPassword)) {
        res.status(401).json({ error: "Mevcut sifre yanlis" });
        return;
      }
      if (!newPassword || newPassword.length < 4) {
        res.status(400).json({ error: "Yeni sifre en az 4 karakter olmali" });
        return;
      }
      config.adminPassword = hashPassword(newPassword);
      saveConfig(config);
      // Tum oturumlari sonlandir
      tokens.clear();
      res.clearCookie("auth-token");
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Topic arama
  app.post("/api/search-topic", async (req: Request, res: Response) => {
    try {
      const { topic } = req.body;
      if (!topic || typeof topic !== "string" || topic.length > 200) { res.status(400).json({ error: "topic gerekli (max 200 karakter)" }); return; }
      const articles = await searchTopics([topic.trim()], config.language);
      res.json({ articles });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Topic tweet uret
  app.post("/api/generate-topic", async (req: Request, res: Response) => {
    try {
      const { topic } = req.body;
      if (!topic) { res.status(400).json({ error: "topic gerekli" }); return; }
      const tweet = await generateTopicTweet(topic, config.geminiApiKey, config.language);
      res.json({ tweet });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // X verify
  app.get("/api/twitter-status", async (_req: Request, res: Response) => {
    const ok = await verifyCredentials();
    res.json({ connected: ok });
  });

  // Dashboard
  app.get("/", (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/html");
    res.send(getDashboardHTML());
  });

  app.listen(config.port, () => {
    console.log(`\nWeb panel: http://localhost:${config.port}`);
  });
}

function mask(s: string): string {
  if (!s || s.length < 8) return "***";
  return s.slice(0, 4) + "..." + s.slice(-4);
}

function getDashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Auto-Poster</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh}
#login-page{display:flex;align-items:center;justify-content:center;min-height:100vh}
.login-box{background:#1e293b;padding:2rem;border-radius:12px;width:340px}
.login-box h2{margin-bottom:1rem;color:#60a5fa}
.login-box input{width:100%;padding:10px 14px;border:1px solid #334155;border-radius:8px;background:#0f172a;color:#e2e8f0;font-size:14px;margin-bottom:12px}
.login-box button{width:100%;padding:10px;border:none;border-radius:8px;background:#3b82f6;color:white;font-size:14px;cursor:pointer;font-weight:600}
.login-box button:hover{background:#2563eb}
.login-error{color:#f87171;font-size:13px;margin-bottom:8px;display:none}
#app{display:none}
.header{background:#1e293b;border-bottom:1px solid #334155;padding:12px 24px;display:flex;align-items:center;justify-content:space-between}
.header h1{font-size:18px;color:#60a5fa}
.header-actions{display:flex;gap:8px;align-items:center}
.btn{padding:8px 16px;border:none;border-radius:6px;font-size:13px;cursor:pointer;font-weight:500;transition:all .15s}
.btn-primary{background:#3b82f6;color:white}.btn-primary:hover{background:#2563eb}
.btn-success{background:#10b981;color:white}.btn-success:hover{background:#059669}
.btn-danger{background:#ef4444;color:white}.btn-danger:hover{background:#dc2626}
.btn-outline{background:transparent;border:1px solid #475569;color:#94a3b8}.btn-outline:hover{border-color:#60a5fa;color:#60a5fa}
.btn:disabled{opacity:.5;cursor:not-allowed}
.container{max-width:1100px;margin:0 auto;padding:20px}
.tabs{display:flex;gap:4px;margin-bottom:20px;background:#1e293b;border-radius:8px;padding:4px;flex-wrap:wrap}
.tab{padding:8px 16px;border:none;background:transparent;color:#94a3b8;border-radius:6px;cursor:pointer;font-size:13px;font-weight:500}
.tab.active{background:#3b82f6;color:white}
.panel{display:none}.panel.active{display:block}
.card{background:#1e293b;border-radius:10px;padding:16px;margin-bottom:12px;border:1px solid #334155}
.card-title{font-size:15px;font-weight:600;margin-bottom:6px}
.card-meta{font-size:12px;color:#64748b;margin-bottom:8px}
.card-text{font-size:13px;color:#94a3b8;line-height:1.5}
.card-actions{margin-top:10px;display:flex;gap:6px}
.tweet-input{width:100%;min-height:100px;padding:12px;background:#0f172a;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:14px;resize:vertical;font-family:inherit}
.log-item{display:flex;gap:12px;align-items:flex-start;padding:12px 0;border-bottom:1px solid #1e293b}
.log-status{width:8px;height:8px;border-radius:50%;margin-top:6px;flex-shrink:0}
.log-status.success{background:#10b981}.log-status.fail{background:#ef4444}
.log-time{font-size:12px;color:#64748b}
.log-tweet{font-size:13px;color:#cbd5e1;margin-top:4px;white-space:pre-wrap}
.status-bar{display:flex;gap:16px;margin-bottom:20px}
.status-item{background:#1e293b;border-radius:8px;padding:14px 18px;flex:1;border:1px solid #334155}
.status-label{font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.5px}
.status-value{font-size:20px;font-weight:700;margin-top:4px}
.status-value.green{color:#10b981}.status-value.blue{color:#60a5fa}.status-value.yellow{color:#fbbf24}
.spinner{display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.3);border-top-color:white;border-radius:50%;animation:spin .6s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.empty{text-align:center;padding:40px;color:#475569}
.config-grid{display:grid;gap:12px}
.config-field label{display:block;font-size:12px;color:#64748b;margin-bottom:4px;text-transform:uppercase}
.config-field input,.config-field select{width:100%;padding:8px 12px;background:#0f172a;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:13px}
.toast{position:fixed;top:20px;right:20px;padding:12px 20px;border-radius:8px;color:white;font-size:13px;z-index:999;animation:slideIn .3s}
.toast.ok{background:#10b981}.toast.err{background:#ef4444}
@keyframes slideIn{from{transform:translateX(100%);opacity:0}to{transform:translateX(0);opacity:1}}
</style>
</head>
<body>
<div id="login-page">
  <div class="login-box">
    <h2>Auto-Poster</h2>
    <p style="color:#64748b;font-size:13px;margin-bottom:16px">Devam etmek icin giris yapin</p>
    <div class="login-error" id="login-error">Yanlis sifre</div>
    <input type="password" id="login-password" placeholder="Sifre" autofocus>
    <button onclick="doLogin()">Giris</button>
  </div>
</div>

<div id="app">
  <div class="header">
    <h1>Auto-Poster</h1>
    <div class="header-actions">
      <span id="twitter-status" style="font-size:12px;color:#64748b"></span>
      <button class="btn btn-outline" onclick="doLogout()">Cikis</button>
    </div>
  </div>
  <div class="container">
    <div class="status-bar">
      <div class="status-item"><div class="status-label">Toplam Post</div><div class="status-value blue" id="stat-total">-</div></div>
      <div class="status-item"><div class="status-label">Basarili</div><div class="status-value green" id="stat-success">-</div></div>
      <div class="status-item"><div class="status-label">Sonraki Post</div><div class="status-value yellow" id="stat-next">-</div></div>
    </div>

    <div class="tabs">
      <button class="tab active" data-tab="articles" onclick="switchTab('articles')">Makaleler</button>
      <button class="tab" data-tab="topics" onclick="switchTab('topics')">Konular</button>
      <button class="tab" data-tab="compose" onclick="switchTab('compose')">Tweet Olustur</button>
      <button class="tab" data-tab="logs" onclick="switchTab('logs')">Gecmis</button>
      <button class="tab" data-tab="settings" onclick="switchTab('settings')">Ayarlar</button>
    </div>

    <!-- Articles -->
    <div class="panel active" id="panel-articles">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <span style="font-size:13px;color:#64748b" id="article-count"></span>
        <div style="display:flex;gap:6px">
          <button class="btn btn-outline" onclick="loadArticles(true)">Yenile</button>
          <button class="btn btn-success" onclick="autoPost()">Otomatik Post</button>
        </div>
      </div>
      <div id="articles-list"></div>
    </div>

    <!-- Topics -->
    <div class="panel" id="panel-topics">
      <div class="card">
        <div class="card-title">Konu Ara & Tweet Uret</div>
        <div class="card-meta">Bir konu yazin, Google News'den arayip tweet uretelim</div>
        <div style="display:flex;gap:8px;margin-top:10px">
          <input type="text" id="topic-input" placeholder="ornek: yapay zeka, startup, web3..." style="flex:1;padding:8px 12px;background:#0f172a;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:13px">
          <button class="btn btn-primary" onclick="searchTopicUI()">Ara</button>
          <button class="btn btn-success" onclick="quickTopicTweet()">Direkt Tweet Uret</button>
        </div>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin:12px 0" id="topic-chips"></div>
      <div id="topic-results"></div>
    </div>

    <!-- Compose -->
    <div class="panel" id="panel-compose">
      <div class="card">
        <div class="card-title">Manuel Tweet</div>
        <div class="card-meta">Bir makale secip tweet uretin veya kendiniz yazin</div>
        <textarea class="tweet-input" id="tweet-text" placeholder="Tweet metninizi yazin veya makalelerden uretin..."></textarea>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px">
          <span style="font-size:12px;color:#64748b" id="char-count">0 / 280</span>
          <button class="btn btn-primary" onclick="sendTweet()">Tweet Gonder</button>
        </div>
      </div>
    </div>

    <!-- Logs -->
    <div class="panel" id="panel-logs"><div id="logs-list"></div></div>

    <!-- Settings -->
    <div class="panel" id="panel-settings">
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <div class="card-title">Siteler & Konular</div>
          <button class="btn btn-primary" onclick="addSiteRow()">+ Site Ekle</button>
        </div>
        <div class="card-meta">Her siteye ozel konular tanimlayabilirsin.</div>
        <div id="sites-list" style="margin-top:12px"></div>
      </div>
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <div class="card-title">Genel Konular</div>
          <button class="btn btn-primary" onclick="addTopicRow()">+ Konu Ekle</button>
        </div>
        <div class="card-meta">Sitelerden bagimsiz, Google News'den aranacak konular</div>
        <div id="topics-list" style="margin-top:12px"></div>
      </div>
      <div class="card">
        <div class="card-title" style="margin-bottom:14px">Genel Ayarlar</div>
        <div class="config-grid" id="config-form"></div>
      </div>
      <div class="card">
        <div class="card-title" style="margin-bottom:14px">API Keyleri</div>
        <div class="config-grid">
          <div class="config-field"><label>Gemini API Key</label><input id="key-gemini" placeholder="AIzaSy..."></div>
          <div class="config-field"><label>X (Twitter) API Key</label><input id="key-tw-app" placeholder="App Key"></div>
          <div class="config-field"><label>X (Twitter) API Secret</label><input id="key-tw-secret" placeholder="App Secret"></div>
          <div class="config-field"><label>X Access Token</label><input id="key-tw-token" placeholder="Access Token"></div>
          <div class="config-field"><label>X Access Token Secret</label><input id="key-tw-tokensecret" placeholder="Access Token Secret"></div>
        </div>
        <div style="margin-top:10px"><button class="btn btn-primary" onclick="saveKeys()">API Keyleri Guncelle</button></div>
        <div class="card-meta" style="margin-top:8px">Bos birakilan alanlar degismez. Sadece degistirmek istediginizi girin.</div>
      </div>
      <div class="card">
        <div class="card-title" style="margin-bottom:14px">Sifre Degistir</div>
        <div class="config-grid">
          <div class="config-field"><label>Mevcut Sifre</label><input type="password" id="pw-current"></div>
          <div class="config-field"><label>Yeni Sifre</label><input type="password" id="pw-new"></div>
          <div class="config-field"><label>Yeni Sifre (Tekrar)</label><input type="password" id="pw-confirm"></div>
        </div>
        <div style="margin-top:10px"><button class="btn btn-danger" onclick="changePassword()">Sifreyi Degistir</button></div>
      </div>
      <div style="margin-top:14px"><button class="btn btn-success" onclick="saveSettings()">Ayarlari Kaydet</button></div>
    </div>
  </div>
</div>

<script>
const API=window.location.pathname.endsWith('/')?window.location.pathname.slice(0,-1):window.location.pathname;
let articleCache=[];

function toast(msg,ok){const d=document.createElement('div');d.className='toast '+(ok?'ok':'err');d.textContent=msg;document.body.appendChild(d);setTimeout(()=>d.remove(),3000)}

// Auth
async function checkAuth(){const r=await fetch(API+'/api/auth-check');const d=await r.json();if(d.authenticated)showApp();else showLogin()}
function showLogin(){document.getElementById('login-page').style.display='flex';document.getElementById('app').style.display='none'}
function showApp(){document.getElementById('login-page').style.display='none';document.getElementById('app').style.display='block';loadAll()}
async function doLogin(){const pw=document.getElementById('login-password').value;const r=await fetch(API+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw})});if(r.ok)showApp();else{document.getElementById('login-error').style.display='block';document.getElementById('login-password').value=''}}
async function doLogout(){await fetch(API+'/api/logout',{method:'POST'});showLogin()}
document.getElementById('login-password').addEventListener('keydown',e=>{if(e.key==='Enter')doLogin()});

// Tabs
function switchTab(name){document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));const tb=document.querySelector('[data-tab="'+name+'"]');if(tb)tb.classList.add('active');document.getElementById('panel-'+name).classList.add('active');if(name==='logs')loadLogs();if(name==='settings')loadSettings();if(name==='topics')loadTopicChips()}
function switchTabDirect(name){document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));const tb=document.querySelector('[data-tab="'+name+'"]');if(tb)tb.classList.add('active');document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));document.getElementById('panel-'+name).classList.add('active')}

// Data
async function loadAll(){loadArticles();loadLogs();loadTwitterStatus()}

async function loadArticles(force){
  const el=document.getElementById('articles-list');
  el.innerHTML='<div class="empty"><div class="spinner"></div> Siteler taraniyor...</div>';
  const url=force?'/api/crawl':'/api/articles';
  const method=force?'POST':'GET';
  const r=await fetch(API+url,{method});
  if(!r.ok){el.innerHTML='<div class="empty">Hata olustu</div>';return}
  const d=await r.json();
  articleCache=d.articles||[];
  document.getElementById('article-count').textContent=articleCache.length+' makale';
  if(articleCache.length===0){el.innerHTML='<div class="empty">Makale bulunamadi</div>';return}
  renderArticles(el,articleCache);
}

function isGNewsUrl(u){return u&&(u.includes('news.google.com/rss/articles/')||u.includes('news.google.com/articles/'))}
function timeAgo(d){if(!d)return '';try{const ms=Date.now()-new Date(d).getTime();const h=Math.floor(ms/3600000);if(h<1)return 'az once';if(h<24)return h+' saat once';return Math.floor(h/24)+' gun once'}catch{return ''}}
function renderArticles(el,articles){
  el.innerHTML=articles.map((a,i)=>{
    const linkHtml=isGNewsUrl(a.url)?'<span style="color:#fbbf24">Google News</span>':'<a href="'+esc(a.url)+'" target="_blank" style="color:#60a5fa">Link</a>';
    const timeHtml=a.publishedAt?(' &middot; <span style="color:#fbbf24">'+timeAgo(a.publishedAt)+'</span>'):'';
    return '<div class="card"><div class="card-title">'+esc(a.title)+'</div><div class="card-meta">'+esc(a.source)+' &middot; '+linkHtml+timeHtml+'</div><div class="card-text">'+esc(a.summary||'(ozet yok)')+'</div><div class="card-actions"><button class="btn btn-primary" data-aidx="'+i+'" onclick="genArticle(this)">Tweet Uret</button></div></div>'
  }).join('');
}

function genArticle(btn){
  const idx=parseInt(btn.dataset.aidx);
  const src=btn.closest('#topic-results')?'topic':'article';
  const article=src==='topic'?topicArticleCache[idx]:articleCache[idx];
  if(!article)return;
  switchTabDirect('compose');
  const ta=document.getElementById('tweet-text');
  ta.value='Tweet uretiliyor...';
  ta.disabled=true;
  fetch(API+'/api/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({article})})
    .then(r=>r.json()).then(d=>{ta.value=d.error?'Hata: '+d.error:d.tweet})
    .catch(e=>{ta.value='Hata: '+e.message})
    .finally(()=>{ta.disabled=false;updateCharCount()});
}

// Topics
let topicArticleCache=[];
async function loadTopicChips(){const r=await fetch(API+'/api/config');const cfg=await r.json();const el=document.getElementById('topic-chips');const topics=cfg.topics||[];el.innerHTML=topics.map(t=>'<button class="btn btn-outline" style="font-size:12px;padding:4px 12px" onclick="document.getElementById(\\'topic-input\\').value=\\''+esc(t)+'\\';searchTopicUI()">'+esc(t)+'</button>').join('')}

async function searchTopicUI(){
  const topic=document.getElementById('topic-input').value.trim();
  if(!topic)return;
  const el=document.getElementById('topic-results');
  el.innerHTML='<div class="empty"><div class="spinner"></div> Araniyor...</div>';
  try{
    const r=await fetch(API+'/api/search-topic',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({topic})});
    const d=await r.json();
    topicArticleCache=d.articles||[];
    if(topicArticleCache.length===0){el.innerHTML='<div class="empty">Sonuc bulunamadi</div>';return}
    el.innerHTML=topicArticleCache.map((a,i)=>{
      const linkHtml=isGNewsUrl(a.url)?'<span style="color:#fbbf24">Google News</span>':'<a href="'+esc(a.url)+'" target="_blank" style="color:#60a5fa">Link</a>';
      const timeHtml=a.publishedAt?(' &middot; <span style="color:#fbbf24">'+timeAgo(a.publishedAt)+'</span>'):'';
      return '<div class="card"><div class="card-title">'+esc(a.title)+'</div><div class="card-meta">'+esc(a.source)+' &middot; '+linkHtml+timeHtml+'</div><div class="card-text">'+esc(a.summary||'(ozet yok)')+'</div><div class="card-actions"><button class="btn btn-primary" data-aidx="'+i+'" onclick="genTopicArticle(this)">Tweet Uret</button></div></div>'
    }).join('');
  }catch(e){el.innerHTML='<div class="empty">Hata: '+esc(e.message)+'</div>'}
}

function genTopicArticle(btn){
  const idx=parseInt(btn.dataset.aidx);
  const article=topicArticleCache[idx];
  if(!article)return;
  switchTabDirect('compose');
  const ta=document.getElementById('tweet-text');
  ta.value='Tweet uretiliyor...';
  ta.disabled=true;
  fetch(API+'/api/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({article})})
    .then(r=>r.json()).then(d=>{ta.value=d.error?'Hata: '+d.error:d.tweet})
    .catch(e=>{ta.value='Hata: '+e.message})
    .finally(()=>{ta.disabled=false;updateCharCount()});
}

async function quickTopicTweet(){
  const topic=document.getElementById('topic-input').value.trim();
  if(!topic){alert('Bir konu girin');return}
  switchTabDirect('compose');
  const ta=document.getElementById('tweet-text');
  ta.value='Konu bazli tweet uretiliyor...';ta.disabled=true;
  try{const r=await fetch(API+'/api/generate-topic',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({topic})});const d=await r.json();ta.value=d.error?'Hata: '+d.error:d.tweet}catch(e){ta.value='Hata: '+e.message}
  ta.disabled=false;updateCharCount();
}

async function sendTweet(){
  const text=document.getElementById('tweet-text').value.trim();
  if(!text)return;
  if(!confirm('Bu tweet gonderilsin mi?'))return;
  try{
    const r=await fetch(API+'/api/post-tweet',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text})});
    const d=await r.json();
    if(d.ok){toast('Tweet gonderildi! ID: '+d.tweetId,true);document.getElementById('tweet-text').value='';updateCharCount();loadLogs()}
    else toast('Hata: '+(d.error||'Bilinmeyen'),false);
  }catch(e){toast('Hata: '+e.message,false)}
}

async function autoPost(){
  if(!confirm('Otomatik post: Site tara > Tweet uret > Gonder. Devam?'))return;
  const btn=event.target;btn.disabled=true;btn.innerHTML='<span class="spinner"></span> Calisiyor...';
  try{const r=await fetch(API+'/api/auto-post',{method:'POST'});const d=await r.json();if(d.ok)toast('Otomatik post tamamlandi!',true);else toast('Hata: '+(d.error||''),false)}catch(e){toast('Hata: '+e.message,false)}
  btn.disabled=false;btn.textContent='Otomatik Post';loadLogs();
}

async function loadLogs(){
  const r=await fetch(API+'/api/logs');const d=await r.json();const logs=(d.logs||[]).reverse();const el=document.getElementById('logs-list');
  document.getElementById('stat-total').textContent=logs.length;
  document.getElementById('stat-success').textContent=logs.filter(l=>l.success).length;
  if(logs.length===0){el.innerHTML='<div class="empty">Henuz post yok</div>';return}
  el.innerHTML=logs.map(l=>'<div class="log-item"><div class="log-status '+(l.success?'success':'fail')+'"></div><div style="flex:1"><div class="log-time">'+new Date(l.timestamp).toLocaleString('tr-TR')+(l.success?'':' - '+esc(l.error||'Hata'))+'</div><div class="log-tweet">'+esc(l.tweet)+'</div></div></div>').join('');
}

async function loadTwitterStatus(){
  const el=document.getElementById('twitter-status');el.textContent='kontrol...';
  try{const r=await fetch(API+'/api/twitter-status');const d=await r.json();el.innerHTML=d.connected?'<span style="color:#10b981">X bagli</span>':'<span style="color:#f87171">X bagli degil</span>'}catch{el.innerHTML='<span style="color:#f87171">Hata</span>'}
}

// Settings
let settingsData=null;
async function loadSettings(){const r=await fetch(API+'/api/config');settingsData=await r.json();renderSitesList();renderTopicsList();renderGeneralSettings()}

function renderSitesList(){
  const el=document.getElementById('sites-list');const sites=settingsData.sites||[];
  if(!sites.length){el.innerHTML='<div class="empty" style="padding:16px">Henuz site eklenmemis</div>';return}
  el.innerHTML=sites.map((s,i)=>{
    const topicTags=(s.topics||[]).map((t,ti)=>'<span style="background:#1e3a5f;color:#60a5fa;padding:2px 8px;border-radius:10px;font-size:11px;display:inline-flex;align-items:center;gap:4px">'+esc(t)+'<span onclick="removeSiteTopic('+i+','+ti+')" style="cursor:pointer;opacity:.7">&times;</span></span>').join('');
    return '<div class="card" style="margin-bottom:8px;padding:12px"><div style="display:flex;gap:8px;align-items:center"><div style="flex:1"><div style="display:flex;gap:8px;margin-bottom:6px"><input class="site-name" data-idx="'+i+'" value="'+esc(s.name)+'" placeholder="Site adi" style="width:150px;padding:6px 10px;background:#0f172a;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:13px"><input class="site-url" data-idx="'+i+'" value="'+esc(s.url)+'" placeholder="https://..." style="flex:1;padding:6px 10px;background:#0f172a;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:13px"></div><div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap"><span style="font-size:11px;color:#64748b">Konular:</span>'+topicTags+'<input class="site-topic-input" data-idx="'+i+'" placeholder="+ konu" style="width:80px;padding:2px 6px;background:transparent;border:1px dashed #334155;border-radius:6px;color:#94a3b8;font-size:11px" onkeydown="if(event.key===\\'Enter\\'){addSiteTopic('+i+',this.value);this.value=\\'\\'}"></div></div><button class="btn btn-danger" style="padding:6px 10px;font-size:12px" onclick="removeSite('+i+')">Sil</button></div></div>'
  }).join('');
}

function addSiteRow(){if(!settingsData)return;settingsData.sites.push({url:'',name:'',topics:[]});renderSitesList();const inp=document.querySelectorAll('.site-name');if(inp.length)inp[inp.length-1].focus()}
function removeSite(i){settingsData.sites.splice(i,1);renderSitesList()}
function addSiteTopic(si,t){t=t.trim();if(!t)return;if(!settingsData.sites[si].topics)settingsData.sites[si].topics=[];settingsData.sites[si].topics.push(t);renderSitesList()}
function removeSiteTopic(si,ti){settingsData.sites[si].topics.splice(ti,1);renderSitesList()}

function renderTopicsList(){
  const el=document.getElementById('topics-list');const topics=settingsData.topics||[];
  if(!topics.length){el.innerHTML='<div class="empty" style="padding:16px">Henuz konu eklenmemis</div>';return}
  el.innerHTML='<div style="display:flex;flex-wrap:wrap;gap:6px">'+topics.map((t,i)=>'<span style="background:#1e293b;border:1px solid #334155;color:#e2e8f0;padding:6px 12px;border-radius:8px;font-size:13px;display:inline-flex;align-items:center;gap:6px">'+esc(t)+'<span onclick="removeTopic('+i+')" style="cursor:pointer;color:#f87171;font-size:16px;line-height:1">&times;</span></span>').join('')+'</div>';
}
function addTopicRow(){const t=prompt('Yeni konu:');if(!t||!t.trim())return;if(!settingsData.topics)settingsData.topics=[];settingsData.topics.push(t.trim());renderTopicsList()}
function removeTopic(i){settingsData.topics.splice(i,1);renderTopicsList()}

function renderGeneralSettings(){
  const c=settingsData;document.getElementById('config-form').innerHTML=
    '<div class="config-field"><label>Dil</label><select id="cfg-lang">'+[['tr','Turkce'],['en','English'],['de','Deutsch'],['fr','Francais'],['es','Espanol'],['it','Italiano'],['pt','Portugues'],['nl','Nederlands'],['ar','Arabic'],['ru','Russian'],['ja','Japanese'],['ko','Korean'],['zh','Chinese']].map(function(l){return '<option value="'+l[0]+'" '+(c.language===l[0]?'selected':'')+'>'+l[1]+'</option>'}).join('')+'</select></div>'+
    '<div class="config-field"><label>Stil</label><select id="cfg-style"><option value="mixed" '+(c.style==='mixed'?'selected':'')+'>Karisik</option><option value="summary" '+(c.style==='summary'?'selected':'')+'>Ozet</option><option value="comment" '+(c.style==='comment'?'selected':'')+'>Yorum</option><option value="info" '+(c.style==='info'?'selected':'')+'>Bilgi</option></select></div>'+
    '<div class="config-field"><label>Zamanlar (virgul ile)</label><input id="cfg-times" value="'+c.schedule.times.join(', ')+'"></div>'+
    '<div class="config-field"><label>Timezone</label><input id="cfg-tz" value="'+c.schedule.timezone+'"></div>';
}

async function saveSettings(){
  document.querySelectorAll('.site-name').forEach(inp=>{settingsData.sites[parseInt(inp.dataset.idx)].name=inp.value.trim()});
  document.querySelectorAll('.site-url').forEach(inp=>{settingsData.sites[parseInt(inp.dataset.idx)].url=inp.value.trim()});
  settingsData.sites=settingsData.sites.filter(s=>s.url);
  const times=document.getElementById('cfg-times').value.split(',').map(s=>s.trim()).filter(Boolean);
  const body={language:document.getElementById('cfg-lang').value,style:document.getElementById('cfg-style').value,schedule:{times,timezone:document.getElementById('cfg-tz').value},sites:settingsData.sites,topics:settingsData.topics||[]};
  const r=await fetch(API+'/api/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(r.ok){toast('Ayarlar kaydedildi!',true);loadSettings()}else toast('Hata!',false);
}

async function saveKeys(){
  const body={};
  const g=document.getElementById('key-gemini').value.trim();
  if(g)body.geminiApiKey=g;
  const tw={};
  const a=document.getElementById('key-tw-app').value.trim();if(a)tw.appKey=a;
  const s=document.getElementById('key-tw-secret').value.trim();if(s)tw.appSecret=s;
  const t=document.getElementById('key-tw-token').value.trim();if(t)tw.accessToken=t;
  const ts=document.getElementById('key-tw-tokensecret').value.trim();if(ts)tw.accessSecret=ts;
  if(Object.keys(tw).length)body.twitter=tw;
  if(!Object.keys(body).length){toast('Degisiklik yok',false);return}
  const r=await fetch(API+'/api/keys',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(r.ok){toast('API keyleri guncellendi!',true);document.querySelectorAll('#key-gemini,#key-tw-app,#key-tw-secret,#key-tw-token,#key-tw-tokensecret').forEach(i=>i.value='');loadSettings()}
  else toast('Hata!',false);
}

async function changePassword(){
  const cur=document.getElementById('pw-current').value;
  const nw=document.getElementById('pw-new').value;
  const cf=document.getElementById('pw-confirm').value;
  if(!cur||!nw){toast('Tum alanlari doldurun',false);return}
  if(nw!==cf){toast('Yeni sifreler eslesmiyor',false);return}
  if(nw.length<4){toast('Sifre en az 4 karakter olmali',false);return}
  const r=await fetch(API+'/api/change-password',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({currentPassword:cur,newPassword:nw})});
  const d=await r.json();
  if(r.ok){toast('Sifre degistirildi! Tekrar giris yapin.',true);setTimeout(()=>showLogin(),1500)}
  else toast(d.error||'Hata',false);
}

document.getElementById('tweet-text').addEventListener('input',updateCharCount);
function updateCharCount(){const l=document.getElementById('tweet-text').value.length;const el=document.getElementById('char-count');el.textContent=l+' / 280';el.style.color=l>280?'#f87171':'#64748b'}

document.addEventListener('keydown',e=>{if(e.target&&e.target.id==='topic-input'&&e.key==='Enter')searchTopicUI()});

function esc(s){const d=document.createElement('div');d.textContent=s||'';return d.innerHTML}

checkAuth();
document.getElementById('stat-next').textContent='-';
</script>
</body>
</html>`;
}
