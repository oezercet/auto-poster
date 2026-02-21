import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

export interface SiteConfig {
  url: string;
  name: string;
  topics?: string[]; // Bu siteye ozel arama konulari
}

export interface ScheduleConfig {
  times: string[];
  timezone: string;
}

export interface TwitterConfig {
  appKey: string;
  appSecret: string;
  accessToken: string;
  accessSecret: string;
}

export interface Config {
  sites: SiteConfig[];
  topics: string[]; // Genel konular - sitelerden bagimsiz tweet uretir
  schedule: ScheduleConfig;
  geminiApiKey: string;
  twitter: TwitterConfig;
  language: string;
  style: string;
  adminPassword: string;
  port: number;
}

export const CONFIG_PATH = join(__dirname, "..", "config.json");

export function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) {
    console.error("config.json bulunamadi!");
    process.exit(1);
  }

  const raw = readFileSync(CONFIG_PATH, "utf-8");
  const config: Config = JSON.parse(raw);

  if (!config.topics) config.topics = [];
  if (!config.adminPassword) config.adminPassword = "admin";
  if (!config.port) config.port = 4000;

  return config;
}

export function saveConfig(config: Config): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}
