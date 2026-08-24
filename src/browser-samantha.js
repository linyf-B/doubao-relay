import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { config } from "./config.js";
import { parseCookieHeaderToPlaywright } from "./cookie-utils.js";

const PC_VERSION = process.env.DOUBAO_PC_VERSION || "3.22.5";
const VERSION_CODE = process.env.DOUBAO_VERSION_CODE || "20800";

/** @type {Map<string, BrowserWorker>} */
const workers = new Map();

function cookieKey(cookieHeader) {
  return crypto.createHash("md5").update(String(cookieHeader || "")).digest("hex").slice(0, 16);
}

class BrowserWorker {
  constructor(cookieHeader, opts = {}) {
    this.cookieHeader = cookieHeader;
    this.key = cookieKey(cookieHeader);
    this.headless = opts.headless !== false;
    this.profileDir = path.join(
      config.browserProfileDir,
      `worker-${this.key}`
    );
    this.context = null;
    this.page = null;
    this.busy = Promise.resolve();
    this.params = {
      device_id: "",
      web_id: "",
      fp: "",
      region: "CN",
      sys_region: "CN",
    };
  }

  async ensureStarted() {
    if (this.page && !this.page.isClosed()) return;
    await fs.mkdir(this.profileDir, { recursive: true });

    const launchOpts = {
      headless: this.headless,
      viewport: { width: 1280, height: 800 },
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
      ],
    };

    try {
      this.context = await chromium.launchPersistentContext(this.profileDir, {
        ...launchOpts,
        channel: "chrome",
      });
    } catch {
      this.context = await chromium.launchPersistentContext(
        this.profileDir,
        launchOpts
      );
    }

    // 先注入 Cookie 再导航，避免游客态初始化
    const cookies = parseCookieHeaderToPlaywright(this.cookieHeader);
    if (cookies.length) {
      await this.context.clearCookies();
      await this.context.addCookies(cookies);
    }

    this.page = this.context.pages()[0] || (await this.context.newPage());
    await this.page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });

    await this.page.goto("https://www.doubao.com/chat/", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await this.waitForFetchHook();
    await this.refreshParams();
  }

  async waitForFetchHook(maxSec = 20) {
    for (let i = 0; i < maxSec; i++) {
      const hooked = await this.page.evaluate(() => {
        try {
          return !window.fetch.toString().includes("native code");
        } catch {
          return false;
        }
      });
      if (hooked) return true;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
  }

  async refreshParams() {
    for (let i = 0; i < 5; i++) {
      const params = await this.page.evaluate(() => {
        const result = {
          device_id: "",
          web_id: "",
          fp: "",
          region: "",
          sys_region: "",
        };
        try {
          const samWeb = JSON.parse(
            localStorage.getItem("samantha_web_web_id") || "{}"
          );
          result.device_id = samWeb.web_id || "";
        } catch {
          // ignore
        }
        try {
          const tea = JSON.parse(
            localStorage.getItem("__tea_cache_tokens_497858") || "{}"
          );
          result.web_id = tea.web_id || "";
        } catch {
          // ignore
        }
        const fpCookie = document.cookie
          .split(";")
          .map((c) => c.trim())
          .find((c) => c.startsWith("s_v_web_id="));
        result.fp = fpCookie ? fpCookie.split("=")[1] : "";
        result.region = localStorage.getItem("flow_user_country") || "CN";
        result.sys_region = result.region || "CN";
        return result;
      });
      this.params = {
        device_id: params.device_id || params.web_id || this.params.device_id,
        web_id: params.web_id || this.params.web_id,
        fp: params.fp || this.params.fp,
        region: params.region || "CN",
        sys_region: params.sys_region || "CN",
      };
      if (this.params.web_id) break;
      await new Promise((r) => setTimeout(r, 800));
    }
  }

  buildQuery() {
    const p = this.params;
    const webTabId = crypto.randomUUID();
    return {
      aid: "497858",
      device_id: p.device_id || "",
      device_platform: "web",
      fp: p.fp || "",
      language: "zh",
      pc_version: PC_VERSION,
      pkg_type: "release_version",
      real_aid: "497858",
      region: p.region || "CN",
      samantha_web: "1",
      sys_region: p.sys_region || "CN",
      tea_uuid: p.web_id || "",
      "use-olympus-account": "1",
      version_code: VERSION_CODE,
      web_id: p.web_id || "",
      web_platform: "browser",
      web_tab_id: webTabId,
    };
  }

  /**
   * @returns {Promise<string>} SSE 原文
   */
  async samanthaPost(payload, timeoutMs = 300000) {
    const run = async () => {
      await this.ensureStarted();
      await this.refreshParams();

      const qs = new URLSearchParams(this.buildQuery()).toString();
      const url = `/samantha/chat/completion?${qs}`;

      const result = await this.page.evaluate(
        async ({ url, payloadJson, timeoutMs: t }) => {
          const csrf =
            document.cookie.match(/passport_csrf_token=([^;]+)/)?.[1] || "";
          const headers = {
            "Content-Type": "application/json",
            Accept: "*/*",
            "agw-js-conv": "str",
          };
          if (csrf) {
            headers["x-tt-passport-csrf-token"] = decodeURIComponent(csrf);
          }
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), t);
          try {
            const res = await fetch(url, {
              method: "POST",
              headers,
              body: payloadJson,
              credentials: "include",
              signal: controller.signal,
            });
            clearTimeout(timer);
            const body = await res.text();
            return {
              ok: res.ok,
              status: res.status,
              body,
              fetchHooked: !window.fetch.toString().includes("native code"),
            };
          } catch (e) {
            clearTimeout(timer);
            return {
              ok: false,
              status: 0,
              body: String(e?.message || e),
              fetchHooked: false,
            };
          }
        },
        { url, payloadJson: JSON.stringify(payload), timeoutMs }
      );

      if (!result.ok) {
        throw new Error(
          `浏览器内请求失败 HTTP ${result.status}: ${String(result.body).slice(0, 400)}`
        );
      }
      return result.body;
    };

    // 串行，避免同一 profile 并发
    const prev = this.busy;
    let release;
    this.busy = new Promise((r) => {
      release = r;
    });
    await prev;
    try {
      return await run();
    } finally {
      release();
    }
  }

  async close() {
    try {
      await this.context?.close();
    } catch {
      // ignore
    }
    this.context = null;
    this.page = null;
  }
}

/**
 * 在常驻浏览器上下文中请求豆包（fetch hook 注入 a_bogus）。
 */
export async function browserSamanthaPost(cookieHeader, payload, opts = {}) {
  const key = cookieKey(cookieHeader);
  let worker = workers.get(key);
  if (!worker) {
    worker = new BrowserWorker(cookieHeader, {
      headless: opts.headless !== false,
    });
    workers.set(key, worker);
  } else if (opts.headless === false && worker.headless) {
    await worker.close();
    workers.delete(key);
    worker = new BrowserWorker(cookieHeader, { headless: false });
    workers.set(key, worker);
  }

  try {
    return await worker.samanthaPost(payload, opts.timeoutMs || 300000);
  } catch (err) {
    // 浏览器挂了则重建一次
    await worker.close();
    workers.delete(key);
    const retry = new BrowserWorker(cookieHeader, {
      headless: opts.headless !== false,
    });
    workers.set(key, retry);
    return retry.samanthaPost(payload, opts.timeoutMs || 300000);
  }
}

export async function closeAllBrowserWorkers() {
  for (const w of workers.values()) {
    await w.close();
  }
  workers.clear();
}
