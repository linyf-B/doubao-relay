import { createApp } from "./gateway.js";
import { config } from "./config.js";
import { sweepExpiredCooldowns, listAccounts } from "./session-store.js";
import { logger } from "./logger.js";
import { isCdpEnabled } from "./cdp-samantha.js";

const app = createApp();

app.listen(config.port, () => {
  logger.info("gateway listening", {
    url: `http://127.0.0.1:${config.port}`,
    admin: `http://127.0.0.1:${config.port}/`,
    upstream: config.upstreamUrl,
    cdp: isCdpEnabled(),
    logFile: logger.filePath(),
  });

  setInterval(async () => {
    try {
      const sweep = await sweepExpiredCooldowns();
      if (sweep.cleared > 0) {
        const accounts = await listAccounts();
        logger.info("cooldown sweep", {
          cleared: sweep.cleared,
          available: accounts.filter((a) => !a.cooling).length,
          total: accounts.length,
        });
      }
    } catch (err) {
      logger.error("cooldown sweep failed", { message: String(err.message || err) });
    }
  }, 15_000);
});
