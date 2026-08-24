import { chromium } from "playwright";
import crypto from "node:crypto";

const PC_VERSION = process.env.DOUBAO_PC_VERSION || "3.22.5";
const VERSION_CODE = process.env.DOUBAO_VERSION_CODE || "20800";

export function isCdpEnabled() {
  return (
    Boolean(String(process.env.DOUBAO_CDP_URL || "").trim()) ||
    String(process.env.DOUBAO_USE_CDP || "").trim() === "1"
  );
}

/**
 * 通过 Chrome/Edge 远程调试在页内 fetch 豆包接口。
 * @param {object} payload
 * @param {{ path?: string, timeoutMs?: number, cdpUrl?: string }} opts
 */
export async function cdpSamanthaPost(payload, opts = {}) {
  const cdpUrl = (
    opts.cdpUrl ||
    process.env.DOUBAO_CDP_URL ||
    "http://127.0.0.1:9222"
  ).replace(/\/$/, "");
  const apiPath = opts.path || "/samantha/chat/completion";

  const browser = await chromium.connectOverCDP(cdpUrl);
  try {
    const context = browser.contexts()[0];
    if (!context) {
      throw new Error("CDP 未找到浏览器上下文，请确认 Chrome/Edge 已用调试端口启动");
    }

    let page =
      context.pages().find((p) => /doubao\.com/i.test(p.url())) ||
      context.pages()[0];
    if (!page) page = await context.newPage();

    if (!/doubao\.com\/chat/i.test(page.url())) {
      await page.goto("https://www.doubao.com/chat/", {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      await new Promise((r) => setTimeout(r, 2000));
    }

    for (let i = 0; i < 15; i++) {
      const hooked = await page.evaluate(() => {
        try {
          return !window.fetch.toString().includes("native code");
        } catch {
          return false;
        }
      });
      if (hooked) break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    const runtime = await page.evaluate(() => {
      let device_id = "";
      let web_id = "";
      let fp = "";
      try {
        device_id =
          JSON.parse(localStorage.getItem("samantha_web_web_id") || "{}")
            .web_id || "";
      } catch {
        // ignore
      }
      try {
        web_id =
          JSON.parse(localStorage.getItem("__tea_cache_tokens_497858") || "{}")
            .web_id || "";
      } catch {
        // ignore
      }
      if (!device_id) device_id = web_id;
      const fpCookie = document.cookie
        .split(";")
        .map((c) => c.trim())
        .find((c) => c.startsWith("s_v_web_id="));
      fp = fpCookie ? fpCookie.split("=")[1] : "";
      return {
        device_id,
        web_id,
        fp,
        region: localStorage.getItem("flow_user_country") || "CN",
      };
    });

    const qsObj = {
      aid: "497858",
      device_id: runtime.device_id || "",
      device_platform: "web",
      language: "zh",
      pc_version: PC_VERSION,
      pkg_type: "release_version",
      real_aid: "497858",
      region: runtime.region || "CN",
      samantha_web: "1",
      sys_region: runtime.region || "CN",
      tea_uuid: runtime.web_id || "",
      "use-olympus-account": "1",
      version_code: VERSION_CODE,
      web_id: runtime.web_id || "",
      web_platform: "browser",
      web_tab_id: crypto.randomUUID(),
    };
    // async/stream 通常不带 fp
    if (!/async\/stream/i.test(apiPath) && runtime.fp) {
      qsObj.fp = runtime.fp;
    }
    const qs = new URLSearchParams(qsObj).toString();
    const url = `${apiPath}?${qs}`;
    const timeoutMs = opts.timeoutMs || 300000;

    const result = await page.evaluate(
      async ({ url, payloadJson, timeoutMs: t }) => {
        const csrf =
          document.cookie.match(/passport_csrf_token=([^;]+)/)?.[1] || "";
        const headers = {
          "Content-Type": "application/json",
          Accept: "*/*",
          "agw-js-conv": "str",
        };
        if (csrf) headers["x-tt-passport-csrf-token"] = decodeURIComponent(csrf);
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
          return { ok: res.ok, status: res.status, body: await res.text() };
        } catch (e) {
          clearTimeout(timer);
          return { ok: false, status: 0, body: String(e?.message || e) };
        }
      },
      { url, payloadJson: JSON.stringify(payload), timeoutMs }
    );

    if (!result.ok) {
      throw new Error(
        `CDP 请求失败 HTTP ${result.status}: ${String(result.body).slice(0, 400)}`
      );
    }
    return result.body;
  } finally {
    // 不要 browser.close()
  }
}
