import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";

const root = config.root;
const freeApiDir = path.join(root, "vendor", "doubao-free-api");
const freeApiEntry = path.join(freeApiDir, "dist", "index.js");

function run(name, command, args, cwd) {
  const child = spawn(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: process.env,
  });
  child.on("exit", (code, signal) => {
    console.log(`[${name}] exited code=${code} signal=${signal}`);
    process.exit(code ?? 1);
  });
  return child;
}

console.log("[start] 启动上游 doubao-free-api（本机 Node，无 Docker）…");
const upstream = run(
  "free-api",
  "node",
  ["--enable-source-maps", "--no-node-snapshot", freeApiEntry],
  freeApiDir
);

// 稍等上游起来再开网关
await new Promise((r) => setTimeout(r, 1500));

console.log("[start] 启动本机网关…");
const gateway = run("gateway", "node", [path.join(root, "src", "index.js")], root);

function shutdown() {
  upstream.kill();
  gateway.kill();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
