import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { config } from "./config.js";
import { parseCookieHeaderToPlaywright } from "./cookie-utils.js";

function isLikelyGeneratedImage(url) {
  const u = String(url || "");
  if (!/^https?:\/\//i.test(u)) return false;
  if (/\/static\/|intro\.|avatar|logo|icon|emoji|favicon|sprite/i.test(u)) {
    return false;
  }
  // 生成图通常在 imagex / byteimg / tos
  return /(byteimg|imagex|tos-cn-i|tos-cn-|\.byteimg\.|pstatp\.com|ibyteimg)/i.test(
    u
  );
}

async function collectPageImageUrls(page) {
  const urls = await page.evaluate(() => {
    const out = [];
    for (const img of document.querySelectorAll("img")) {
      const src = img.currentSrc || img.src || "";
      if (src) out.push(src);
    }
    for (const el of document.querySelectorAll("[style*='background']")) {
      const m = String(el.getAttribute("style") || "").match(
        /url\(["']?(https?:\/\/[^"')]+)/
      );
      if (m?.[1]) out.push(m[1]);
    }
    return out;
  });
  return [...new Set(urls.map((u) => u.replace(/\\u0026/g, "&")))];
}

/**
 * 走真实 UI 发消息生图（最接近网页，成功率最高，也最慢）。
 */
export async function generateImageViaUi(opts = {}) {
  const cookieHeader = String(opts.cookieHeader || "").trim();
  const prompt = String(opts.prompt || "").trim();
  if (!cookieHeader) throw new Error("缺少 Cookie");
  if (!prompt) throw new Error("prompt 不能为空");

  const ratio = opts.ratio || "1:1";
  const text = `请生成一张图片：${prompt}。比例 ${ratio}`;
  const key = crypto
    .createHash("md5")
    .update(cookieHeader)
    .digest("hex")
    .slice(0, 12);
  const profileDir = path.join(config.browserProfileDir, `ui-${key}`);
  await fs.mkdir(profileDir, { recursive: true });

  const headless = opts.headless !== false;
  const launchOpts = {
    headless,
    viewport: { width: 1280, height: 900 },
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
    context = await chromium.launchPersistentContext(profileDir, launchOpts);
  }

  try {
    const cookies = parseCookieHeaderToPlaywright(cookieHeader);
    if (cookies.length) {
      await context.clearCookies();
      await context.addCookies(cookies);
    }

    const page = context.pages()[0] || (await context.newPage());
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });

    // 拦截 completion 响应，直接拿 SSE 里的图（比 DOM 更准）
    /** @type {string[]} */
    const intercepted = [];
    page.on("response", async (res) => {
      try {
        const u = res.url();
        if (!/samantha\/chat\/completion/i.test(u)) return;
        if (res.status() !== 200) return;
        const body = await res.text();
        const matches = body.match(/https?:\\?\/\\?\/[^\s"'\\]+/g) || [];
        for (let m of matches) {
          m = m.replace(/\\\//g, "/").replace(/\\u0026/g, "&");
          if (isLikelyGeneratedImage(m)) intercepted.push(m);
        }
        // 也解析 image_ori.url 形态
        const ori = [
          ...body.matchAll(/"url"\s*:\s*"(https?:[^"]+)"/g),
        ].map((x) => x[1].replace(/\\u0026/g, "&"));
        for (const x of ori) {
          if (isLikelyGeneratedImage(x)) intercepted.push(x);
        }
      } catch {
        // ignore
      }
    });

    await page.goto("https://www.doubao.com/chat/", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));

    const before = new Set(
      (await collectPageImageUrls(page)).filter(isLikelyGeneratedImage)
    );

    const editors = [
      '[contenteditable="true"]',
      "textarea",
      '[data-testid="chat_input_input"]',
    ];
    let filled = false;
    for (const sel of editors) {
      const loc = page.locator(sel).first();
      if ((await loc.count()) === 0) continue;
      try {
        await loc.click({ timeout: 3000 });
        await loc.fill(text);
        filled = true;
        break;
      } catch {
        try {
          await loc.click({ timeout: 2000 });
          await page.keyboard.type(text, { delay: 12 });
          filled = true;
          break;
        } catch {
          // next
        }
      }
    }
    if (!filled) {
      throw new Error("未找到豆包输入框，请用管理页「浏览器登录」后再试");
    }

    const sendBtns = [
      'button:has-text("发送")',
      '[data-testid="chat_input_send_button"]',
      'button[aria-label*="发送"]',
    ];
    let sent = false;
    for (const sel of sendBtns) {
      const btn = page.locator(sel).first();
      if ((await btn.count()) === 0) continue;
      try {
        await btn.click({ timeout: 3000 });
        sent = true;
        break;
      } catch {
        // continue
      }
    }
    if (!sent) await page.keyboard.press("Enter");

    const deadline = Date.now() + (opts.timeoutMs || 180000);
    const images = [];
    const seen = new Set();

    const push = (u) => {
      const clean = String(u).replace(/\\u0026/g, "&");
      if (!isLikelyGeneratedImage(clean)) return;
      const k = clean.split("~")[0].split("?")[0];
      if (before.has(clean) || before.has(k) || seen.has(k)) return;
      seen.add(k);
      images.push(clean);
    };

    while (Date.now() < deadline) {
      for (const u of intercepted) push(u);
      for (const u of await collectPageImageUrls(page)) push(u);

      if (images.length > 0) {
        await new Promise((r) => setTimeout(r, 2000));
        for (const u of intercepted) push(u);
        break;
      }

      const errText = await page.evaluate(() => {
        const t = document.body?.innerText || "";
        if (/操作过于频繁|rate\s*limited|系统繁忙/i.test(t)) return t.slice(0, 120);
        return "";
      });
      if (errText && Date.now() > deadline - 120000) {
        // keep waiting a bit; UI errors may flash
      }

      await new Promise((r) => setTimeout(r, 2000));
    }

    if (!images.length) {
      throw new Error(
        "UI 生图超时未拿到生成图。若网页能出图，请在管理页点「浏览器登录」刷新 Cookie 后重试。"
      );
    }

    return {
      ok: true,
      model: opts.model || "Seedream",
      ratio,
      content: "",
      images,
      via: "ui",
    };
  } finally {
    try {
      await context.close();
    } catch {
      // ignore
    }
  }
}
