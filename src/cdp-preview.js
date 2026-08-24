import { chromium } from "playwright";

function cdpEndpoint() {
  return (
    process.env.DOUBAO_CDP_URL ||
    "http://127.0.0.1:9222"
  ).replace(/\/$/, "");
}

export function isCdpConfigured() {
  return (
    Boolean(String(process.env.DOUBAO_CDP_URL || "").trim()) ||
    String(process.env.DOUBAO_USE_CDP || "").trim() === "1"
  );
}

/**
 * 探测 CDP 是否在线（不依赖 Playwright）。
 */
export async function probeCdp() {
  const base = cdpEndpoint();
  try {
    const res = await fetch(`${base}/json/version`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) {
      return { ok: false, endpoint: base, message: `HTTP ${res.status}` };
    }
    const info = await res.json();
    return {
      ok: true,
      endpoint: base,
      browser: info.Browser || info.browser || "",
      userAgent: info["User-Agent"] || "",
      configured: isCdpConfigured(),
    };
  } catch (err) {
    return {
      ok: false,
      endpoint: base,
      configured: isCdpConfigured(),
      message: String(err.message || err),
    };
  }
}

/**
 * 截取调试浏览器中豆包页画面（JPEG base64）。
 * Chrome / Edge 均可（只要开了 --remote-debugging-port）。
 */
export async function captureCdpScreenshot(opts = {}) {
  const base = cdpEndpoint();
  const browser = await chromium.connectOverCDP(base);
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error("CDP 无浏览器上下文");

    let page =
      context.pages().find((p) => /doubao\.com/i.test(p.url())) ||
      context.pages()[0];
    if (!page) page = await context.newPage();

    if (opts.ensureDoubao !== false && !/doubao\.com/i.test(page.url())) {
      await page.goto("https://www.doubao.com/chat/", {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });
    }

    const buf = await page.screenshot({
      type: "jpeg",
      quality: opts.quality || 62,
      fullPage: false,
    });

    return {
      ok: true,
      mime: "image/jpeg",
      base64: buf.toString("base64"),
      url: page.url(),
      title: await page.title().catch(() => ""),
    };
  } finally {
    // 不要 browser.close()，否则会关掉用户 Edge/Chrome
  }
}
