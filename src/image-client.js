import crypto from "node:crypto";
import { createParser } from "eventsource-parser";
import { browserSamanthaPost } from "./browser-samantha.js";
import { getCookieValue } from "./cookie-utils.js";
import { generateImageViaUi } from "./image-ui.js";
import { cdpSamanthaPost, isCdpEnabled } from "./cdp-samantha.js";
import {
  uploadReferenceImages,
  buildAttachments,
  normalizeRefPrompt,
} from "./image-upload.js";
import { logger } from "./logger.js";

const ASSISTANT_ID = "497858";
const VERSION_CODE = "20800";
const PC_VERSION = "2.44.0";

/** 默认优先浏览器页内请求（Node 直连易触发 710022004） */
const PREFER_BROWSER =
  String(process.env.DOUBAO_IMAGE_VIA_BROWSER || "1").trim() !== "0";

function randomDigits(n) {
  let s = "";
  while (s.length < n) s += Math.floor(Math.random() * 10);
  return s.slice(0, n);
}

function uuid() {
  return crypto.randomUUID();
}

function buildQuery() {
  const deviceId = `7${randomDigits(18)}`;
  const webId = `7${randomDigits(18)}`;
  return {
    aid: ASSISTANT_ID,
    device_id: deviceId,
    device_platform: "web",
    language: "zh",
    pc_version: PC_VERSION,
    pkg_type: "release_version",
    real_aid: ASSISTANT_ID,
    region: "CN",
    samantha_web: "1",
    sys_region: "CN",
    tea_uuid: webId,
    "use-olympus-account": "1",
    version_code: VERSION_CODE,
    web_id: webId,
    web_tab_id: uuid(),
  };
}

export class RateLimitError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = "RateLimitError";
    this.type = "rate_limited";
    this.detail = detail;
  }
}

function parseSseEvents(rawText) {
  const events = [];
  const parser = createParser((ev) => {
    if (ev.type !== "event" || !ev.data) return;
    try {
      events.push(JSON.parse(ev.data));
    } catch {
      // ignore
    }
  });
  parser.feed(rawText);
  return events;
}

function unwrapEventData(data) {
  let ed = data?.event_data;
  if (typeof ed === "string") {
    try {
      ed = JSON.parse(ed);
    } catch {
      return null;
    }
  }
  return ed;
}

function detectRateLimit(events) {
  for (const ev of events) {
    const ed = unwrapEventData(ev) || {};
    const code = ed.code || ed.error_detail?.code || ev.code;
    const msg = String(ed.message || ed.error_detail?.message || ev.message || "");
    if (
      code === 710022004 ||
      /rate\s*limited/i.test(msg) ||
      /shark_admin|verify_scene|系统错误/.test(JSON.stringify(ed))
    ) {
      return { code, message: msg || "rate limited", raw: ed };
    }
    // event_type 2005 常为错误事件
    if (ev.event_type === 2005 && (code || /rate|limit|verify|错误/.test(msg))) {
      return { code: code || 2005, message: msg || "上游拒绝请求", raw: ed };
    }
  }
  return null;
}

function collectImages(events) {
  const imageUrls = [];
  const seen = new Set();

  const add = (url, key) => {
    if (!url || typeof url !== "string") return;
    let u = url.replace(/\\u0026/g, "&").replace(/&amp;/g, "&");
    if (!/^https?:\/\//.test(u)) return;
    if (!/(\.png|\.jpe?g|\.webp|byteimg|imagex|tos-cn)/i.test(u)) return;
    const dedupe = key || u.split("?")[0];
    if (seen.has(dedupe) || seen.has(u)) return;
    seen.add(dedupe);
    seen.add(u);
    imageUrls.push(u);
  };

  for (const ev of events) {
    if (ev.event_type !== 2001) continue;
    const ed = unwrapEventData(ev);
    let msg = ed?.message;
    if (typeof msg === "string") {
      try {
        msg = JSON.parse(msg);
      } catch {
        continue;
      }
    }
    if (!msg) continue;
    const ctype = msg.content_type;
    let content = msg.content;
    if (typeof content === "string") {
      try {
        content = JSON.parse(content);
      } catch {
        // keep string
      }
    }

    // 新版：content_type 2010，data[]
    if (ctype === 2010 && content && Array.isArray(content.data)) {
      for (const item of content.data) {
        const ori = item?.image_ori || {};
        const raw = item?.image_raw || {};
        const thumb = item?.image_thumb || {};
        const preview = item?.image_preview || {};
        add(
          ori.url || raw.url || preview.url || thumb.url || item?.url,
          item?.key
        );
      }
    }

    // 旧版：2074 creations[]
    if (ctype === 2074 && content && Array.isArray(content.creations)) {
      for (const c of content.creations) {
        const img = c?.image || {};
        add(
          img?.image_ori?.url ||
            img?.image_raw?.url ||
            img?.image_preview?.url ||
            img?.image_thumb?.url ||
            img?.url ||
            c?.url,
          img?.key || c?.key
        );
      }
    }

    // 文本兜底
    const text =
      (typeof content === "object" && content?.text) ||
      (typeof msg.content === "string" ? msg.content : "");
    if (typeof text === "string") {
      const matches = text.match(/https?:\/\/[^\s)"']+/g) || [];
      for (const u of matches) add(u);
    }
  }
  return imageUrls;
}

function collectText(events) {
  const parts = [];
  for (const ev of events) {
    const ed = unwrapEventData(ev);
    let msg = ed?.message;
    if (typeof msg === "string") {
      try {
        msg = JSON.parse(msg);
      } catch {
        continue;
      }
    }
    let content = msg?.content;
    if (typeof content === "string") {
      try {
        content = JSON.parse(content);
      } catch {
        // ignore
      }
    }
    if (typeof content?.text === "string") parts.push(content.text);
  }
  return parts.join("");
}

async function samanthaPost(cookieHeader, body, timeoutMs = 180000) {
  const qs = new URLSearchParams(buildQuery()).toString();
  const url = `https://www.doubao.com/samantha/chat/completion?${qs}`;
  const csrf =
    getCookieValue(cookieHeader, "passport_csrf_token") ||
    getCookieValue(cookieHeader, "passport_csrf_token_default");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = {
      Accept: "*/*",
      "Accept-Language": "zh-CN,zh;q=0.9",
      "Content-Type": "application/json",
      Cookie: cookieHeader,
      Origin: "https://www.doubao.com",
      Referer: "https://www.doubao.com/chat/",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "agw-js-conv": "str",
    };
    if (csrf) headers["x-tt-passport-csrf-token"] = csrf;
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`豆包生图 HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function parseImageResult(raw, model, ratio) {
  const events = parseSseEvents(raw);
  const limited = detectRateLimit(events);
  if (limited) {
    throw new RateLimitError(
      `豆包风控 shark（${limited.code || "rate_limited"}）。粘贴 Cookie + 自动化浏览器常被拦；请改用本机 Chrome 调试模式（DOUBAO_USE_CDP=1）或管理页「浏览器登录」。`,
      limited
    );
  }
  const images = collectImages(events);
  const text = collectText(events);
  if (!images.length) {
    throw new Error(
      text
        ? `生图未返回图片：${text.slice(0, 200)}`
        : "生图未返回图片（空响应）。可能被风控，请换账号登录。"
    );
  }
  return { ok: true, model, ratio, content: text, images };
}

/**
 * @param {{
 *   cookieHeader: string,
 *   prompt: string,
 *   model?: string,
 *   ratio?: string,
 *   style?: string,
 *   images?: string[],
 *   useCdp?: boolean,
 *   preferBrowser?: boolean,
 *   headless?: boolean,
 * }} opts
 */
export async function generateImage(opts = {}) {
  const cookieHeader = String(opts.cookieHeader || "").trim();
  if (!cookieHeader) throw new Error("缺少 Cookie，请重新登录豆包");

  let prompt = String(opts.prompt || "").trim();
  if (!prompt) throw new Error("prompt 不能为空");
  const model = opts.model || "Seedream 4.5";
  const ratio = opts.ratio || "1:1";
  const style = opts.style || "默认";
  const refInputs = Array.isArray(opts.images)
    ? opts.images.filter(Boolean)
    : opts.image
      ? [opts.image]
      : [];

  let attachments = [];
  if (refInputs.length) {
    logger.info("image upload refs start", { count: refInputs.length });
    const uploaded = await uploadReferenceImages(cookieHeader, refInputs, 6);
    const normalized = normalizeRefPrompt(prompt, uploaded.length, {
      returnMeta: true,
    });
    const uploadOrder = Array.isArray(normalized?.uploadOrder)
      ? normalized.uploadOrder
      : uploaded.map((_, i) => i);
    const reordered = uploadOrder
      .map((i) => uploaded[i])
      .filter(Boolean);
    const finalUploaded =
      reordered.length === uploadOrder.length && reordered.length > 0
        ? reordered
        : uploaded;
    const names = normalized?.names || [];
    attachments = buildAttachments(finalUploaded, { names });
    prompt = typeof normalized === "string" ? normalized : normalized.text;
    const previews = finalUploaded.map((u) => u.preview).filter(Boolean);
    const characters = normalized?.characters || [];
    logger.info("image upload refs done", {
      uploaded: attachments.length,
      uploadOrder,
      attachmentNames: attachments.map((a) => a.name),
      attachmentKeys: attachments.map((a) => String(a.key || "").slice(0, 48)),
      characters: characters.map((c) => `${c.name}=@图片${c.slot}`),
      locationOnly: (normalized?.locationOnly || []).map(
        (c) => `${c.name}=@图片${c.slot}`
      ),
      actors: (normalized?.actors || []).map(
        (c) => `${c.name}=@图片${c.slot}`
      ),
      promptHasAt: /@图片\d/.test(prompt),
      promptHead: prompt.slice(0, 360),
      previews,
    });
    if (!attachments.length) {
      logger.warn("all ref uploads failed, fallback to text-only");
    } else {
      logger.info(`参考图 @图片1…@图片${attachments.length} 已写入 attachments`, {
        count: attachments.length,
        uploadOrder,
        characters: characters.map((c) => `${c.name}=@图片${c.slot}`),
        previews,
      });
    }
  } else {
    prompt = normalizeRefPrompt(prompt, 0);
  }

  // 与网页 / free-api 对齐：content 带 model + template，attachments 才能稳定吃参考图
  const contentData = {
    text: prompt,
    model: model,
    template_type: "placeholder",
    use_creation: false,
  };
  if (ratio) contentData.ratio = ratio;
  if (style && style !== "默认") {
    contentData.text = `${prompt}\n风格：${style}`;
  }

  const payload = {
    messages: [
      {
        content: JSON.stringify(contentData),
        content_type: 2009,
        attachments,
        references: [],
        skill: {
          skill_type: 3,
          skill_type_no_default: 3,
          skill_id: "3",
          skill_id_no_default: "3",
        },
      },
    ],
    completion_option: {
      is_regen: false,
      with_suggest: true,
      need_create_conversation: true,
      launch_stage: 1,
      is_replace: false,
      is_delete: false,
      is_ai_playground: false,
      memory_type: 2,
      message_from: 0,
      use_deep_think: false,
      use_auto_cot: false,
      resend_for_regen: false,
      enable_commerce_credit: false,
      action_bar_skill_id: 3,
    },
    evaluate_option: { web_ab_params: "" },
    local_conversation_id: uuid(),
    local_message_id: uuid(),
  };

  const preferBrowser = opts.preferBrowser ?? PREFER_BROWSER;
  /** @type {Array<'cdp'|'browser'|'http'>} */
  const channels = [];
  if (isCdpEnabled() || opts.useCdp) channels.push("cdp");
  // 已走 CDP 时，不再用 Node/Playwright 冷启动（易触发 shark）
  if (!(opts.useCdp || isCdpEnabled())) {
    if (preferBrowser) channels.push("browser", "http");
    else channels.push("http", "browser");
  } else if (String(process.env.DOUBAO_CDP_FALLBACK || "0") === "1") {
    channels.push("browser", "http");
  }

  let lastErr = null;
  for (const ch of channels) {
    try {
      let raw;
      if (ch === "cdp") {
        raw = await cdpSamanthaPost(payload, { timeoutMs: 300000 });
      } else if (ch === "browser") {
        raw = await browserSamanthaPost(cookieHeader, payload, {
          timeoutMs: 300000,
          headless: opts.headless !== false,
        });
      } else {
        raw = await samanthaPost(cookieHeader, payload, 300000);
      }
      return parseImageResult(raw, model, ratio);
    } catch (err) {
      lastErr = err;
      continue;
    }
  }

  // 710022004 多为验证码/风控：有头浏览器再试一次，方便人工过验证
  if (
    lastErr instanceof RateLimitError &&
    opts.headless !== false &&
    String(process.env.DOUBAO_CAPTCHA_HEADED || "1") !== "0"
  ) {
    try {
      const raw = await browserSamanthaPost(cookieHeader, payload, {
        timeoutMs: 300000,
        headless: false,
      });
      return parseImageResult(raw, model, ratio);
    } catch (err) {
      lastErr = err;
    }
  }

  // 最后手段：真实 UI（默认关闭，太慢且同样易被风控；设 DOUBAO_IMAGE_UI_FALLBACK=1 开启）
  if (String(process.env.DOUBAO_IMAGE_UI_FALLBACK || "0") === "1") {
    try {
      return await generateImageViaUi({
        cookieHeader,
        prompt,
        model,
        ratio,
        style,
        headless: opts.headless !== false,
        timeoutMs: 180000,
      });
    } catch (err) {
      lastErr = err;
    }
  }

  throw lastErr || new Error("生图失败");
}
