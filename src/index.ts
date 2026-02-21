import { loadConfig } from "./config";
import { initTwitterClient } from "./twitter";
import { startScheduler } from "./scheduler";
import { startServer } from "./server";

async function main(): Promise<void> {
  console.log("Auto-Poster baslatiliyor...\n");

  // Config yukle
  const config = loadConfig();
  console.log(`${config.sites.length} site yapilandirildi`);
  console.log(`Dil: ${config.language}, Stil: ${config.style}`);

  // Twitter client baslat (keyler varsa)
  if (config.twitter?.appKey && config.twitter.appKey !== "YOUR_API_KEY") {
    initTwitterClient(config.twitter);
  } else {
    console.log("Twitter API keyleri girilmemis - tweet gonderme devre disi.");
  }

  // Scheduler baslat
  startScheduler(config);

  // Web server baslat
  startServer(config);
}

main().catch((err) => {
  console.error("Kritik hata:", err);
  process.exit(1);
});
