import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { config } from "./config.js";
import { upsertAccount, maskSession, buildCookieHeader } from "./session-store.js";

const POLL_MS = 1500;
const TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 打开可见浏览器登录豆包，抓取 sessionid + 完整 Cookie。
 * @param {{ onStatus?: (msg: string) => void, label?: string, clearProfile?: boolean }} opts
 */
export async function loginAndCaptureSession(opts = {}) {
  const onStatus = opts.onStatus || (() => {});
  await fs.mkdir(config.browserProfileDir, { recursive: true });

  // 换账号时用独立 profile，避免旧登录态干扰
  const profileDir = opts.clearProfile
    ? path.join(config.browserProfileDir, `acct-${Date.now()}`)
    : config.browserProfileDir;
  await fs.mkdir(profileDir, { recursive: true });

  onStatus("正在启动浏览器…");
  const launchOpts = {
    headless: false,
    viewport: { width: 1280, height: 860 },
    locale: "zh-CN",
    args: ["--disable-blink-features=AutomationControlled"],
  };

  let context;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      ...launchOpts,
      channel: "chrome",
    });
  } catch {
    onStatus("未检测到本机 Chrome，尝试 Playwright Chromium…");
    context = await chromium.launchPersistentContext(profileDir, launchOpts);
  }

  try {
    const page = context.pages()[0] || (await context.newPage());
    onStatus(`请在弹出的窗口中登录豆包：${config.doubaoUrl}`);
    if (opts.clearProfile) {
      // 尽量进入未登录态
      await page.goto("https://www.doubao.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
    }
    await page.goto(config.doubaoUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

    const started = Date.now();
    let lastSid = "";
    while (Date.now() - started < TIMEOUT_MS) {
      const cookies = await context.cookies([
        "https://www.doubao.com",
        "https://doubao.com",
        "https://www.doubao.com/chat/",
      ]);
      const session = cookies.find((c) => c.name === "sessionid" && c.value);
      if (session?.value) {
        // 登录后稍等，让其它 cookie（ttwid / csrf）落盘
        if (session.value !== lastSid) {
          lastSid = session.value;
          onStatus(`已检测到 session，等待 Cookie 齐套…`);
          await page.waitForTimeout(2500);
          const cookies2 = await context.cookies([
            "https://www.doubao.com",
            "https://doubao.com",
          ]);
          const cookieHeader = buildCookieHeader(cookies2);
          const saved = await upsertAccount(session.value, {
            source: "playwright",
            cookieHeader,
            label: opts.label,
            setActive: true,
          });
          onStatus(`已保存账号：${maskSession(saved.sessionId)}（完整 Cookie ${cookies2.length} 条）`);
          await context.close();
          return saved;
        }
      }
      onStatus(
        opts.clearProfile
          ? "换账号：请扫码/登录新账号…"
          : "等待登录中…（扫码或账密登录后会自动保存）"
      );
      await page.waitForTimeout(POLL_MS);
    }

    throw new Error("登录超时：5 分钟内未检测到 sessionid，请重试");
  } catch (err) {
    try {
      await context.close();
    } catch {
      // ignore
    }
    throw err;
  }
}

// CLI: npm run login
const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  const switchAccount = process.argv.includes("--switch");
  loginAndCaptureSession({
    clearProfile: switchAccount,
    label: switchAccount ? `换号 ${new Date().toLocaleString()}` : undefined,
    onStatus: (msg) => console.log(`[login] ${msg}`),
  })
    .then((s) => {
      console.log("[login] 成功，已写入 data/session.json");
      console.log(`[login] id=${s.id} session=${maskSession(s.sessionId)}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error("[login] 失败:", err.message || err);
      process.exit(1);
    });
}
