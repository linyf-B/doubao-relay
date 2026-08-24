import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

dotenv.config({ path: path.join(root, ".env") });

export const config = {
  root,
  port: Number(process.env.PORT || 8787),
  localApiKey: process.env.LOCAL_API_KEY || "local-dev-key-change-me",
  upstreamUrl: (process.env.UPSTREAM_URL || "http://127.0.0.1:8001").replace(/\/$/, ""),
  dataDir: path.join(root, "data"),
  sessionFile: path.join(root, "data", "session.json"),
  logDir: path.resolve(root, process.env.LOG_DIR || "data/logs"),
  browserProfileDir: path.resolve(
    root,
    process.env.BROWSER_PROFILE_DIR || "data/browser-profile"
  ),
  doubaoUrl: "https://www.doubao.com/chat/",
};
