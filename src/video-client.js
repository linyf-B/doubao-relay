import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createParser } from "eventsource-parser";
import { config } from "./config.js";
import { cdpSamanthaPost, isCdpEnabled } from "./cdp-samantha.js";
import { getCookieValue } from "./cookie-utils.js";
import { logger } from "./logger.js";

const ASSISTANT_ID = "497858";
const VERSION_CODE = process.env.DOUBAO_VERSION_CODE || "20800";
const PC_VERSION = process.env.DOUBAO_PC_VERSION || "3.22.5";

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

function detectBlocked(rawText, events) {
  const blob = `${rawText}\n${JSON.stringify(events).slice(0, 4000)}`;
  if (/710022004|shark_admin|rate\s*limited/i.test(blob)) {
    return "豆包风控 shark：请保持调试浏览器登录（DOUBAO_USE_CDP=1）";
  }
  return null;
}

function walkFindTaskId(node, found = []) {
  if (!node || typeof node !== "object") return found;
  if (Array.isArray(node)) {
    for (const item of node) walkFindTaskId(item, found);
    return found;
  }

  const fr = node.fin_reason || node.finReason;
  if (fr && typeof fr === "object") {
    const asyncTask = fr.async_task || fr.asyncTask || {};
    const id = asyncTask.id || fr.asyncTaskId || fr.async_task_id || fr.task_id;
    if (id && String(id) !== "0") found.push(String(id));
  }

  for (const key of [
    "task_id",
    "taskId",
    "async_task_id",
    "asyncTaskId",
    "video_task_id",
    "provider_task_id",
  ]) {
    const v = node[key];
    if (v != null && String(v) !== "0" && String(v).length >= 6) {
      found.push(String(v));
    }
  }

  for (const v of Object.values(node)) walkFindTaskId(v, found);
  return found;
}

function extractTaskIdFromEvents(events) {
  // 优先：fin_reason.reason === 1
  for (const data of events) {
    const ed = unwrapEventData(data);
    const fr = ed?.fin_reason;
    if (fr && (fr.reason === 1 || fr.reason === "1")) {
      const id = fr.async_task?.id || fr.asyncTask?.id;
      if (id && String(id) !== "0") return String(id);
    }
  }
  const all = walkFindTaskId(events);
  return all.find((id) => id && id !== "0") || "";
}

function walkFindConversationId(node) {
  if (!node || typeof node !== "object") return "";
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = walkFindConversationId(item);
      if (hit) return hit;
    }
    return "";
  }
  for (const key of ["conversation_id", "conversationId", "thread_id"]) {
    const v = node[key];
    if (typeof v === "string" && /^\d{10,}$/.test(v)) return v;
    if (typeof v === "number" && String(v).length >= 10) return String(v);
  }
  for (const v of Object.values(node)) {
    const hit = walkFindConversationId(v);
    if (hit) return hit;
  }
  return "";
}

function collectText(events) {
  const parts = [];
  for (const data of events) {
    const ed = unwrapEventData(data);
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
        continue;
      }
    }
    if (content?.text) parts.push(String(content.text));
  }
  return parts.join("");
}

function extractVideos(events) {
  const videos = [];
  const seen = new Set();

  const add = (url, meta = {}) => {
    if (!url || typeof url !== "string") return;
    if (!/^https?:\/\//.test(url)) return;
    if (/\.(png|jpe?g|webp|gif)(~|\?|$)/i.test(url)) return;
    if (!/(\.mp4|\.m3u8|\/video\/|video)/i.test(url)) return;
    if (seen.has(url)) return;
    seen.add(url);
    videos.push({
      video_url: url,
      cover_url: meta.cover_url || "",
      width: meta.width || 0,
      height: meta.height || 0,
      duration: meta.duration || 0,
    });
  };

  const decodeMaybeB64Url = (value) => {
    if (typeof value !== "string" || value.length < 16) return "";
    try {
      const pad = "=".repeat((4 - (value.length % 4)) % 4);
      const decoded = Buffer.from(value + pad, "base64").toString("utf8");
      return /^https?:\/\//.test(decoded) ? decoded : "";
    } catch {
      return "";
    }
  };

  for (const data of events) {
    if (data.event_type !== 2001) continue;
    const ed = unwrapEventData(data);
    let msg = ed?.message;
    if (typeof msg === "string") {
      try {
        msg = JSON.parse(msg);
      } catch {
        continue;
      }
    }
    if (!msg || msg.content_type !== 2021) continue;

    let content = msg.content;
    if (typeof content === "string") {
      try {
        content = JSON.parse(content);
      } catch {
        continue;
      }
    }
    const items = Array.isArray(content?.data) ? content.data : [content];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      let videoUrl = item.video_url || item.url || "";
      if (!videoUrl && item.video_model) {
        try {
          const vm =
            typeof item.video_model === "string"
              ? JSON.parse(item.video_model)
              : item.video_model;
          const vlist = vm?.video_list || {};
          for (const vinfo of Object.values(vlist)) {
            const mainB64 = vinfo?.main_url;
            if (mainB64) {
              videoUrl = decodeMaybeB64Url(mainB64) || videoUrl;
              if (videoUrl) break;
            }
          }
        } catch {
          // ignore
        }
      }
      const cover =
        item.cover_url ||
        (typeof item.cover === "object" ? item.cover?.url : "") ||
        "";
      add(videoUrl, {
        cover_url: cover,
        width: item.width || 0,
        height: item.height || 0,
        duration: item.duration || 0,
      });
    }
  }
  return videos;
}

async function samanthaHttpPost(cookieHeader, apiPath, body, timeoutMs) {
  const qs = new URLSearchParams(buildQuery()).toString();
  const url = `https://www.doubao.com${apiPath}?${qs}`;
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
      throw new Error(`豆包接口失败 HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function samanthaPost(opts, apiPath, body, timeoutMs) {
  if (opts.useCdp || isCdpEnabled()) {
    return cdpSamanthaPost(body, { path: apiPath, timeoutMs });
  }
  const cookieHeader = String(opts.cookieHeader || "").trim();
  if (!cookieHeader) throw new Error("缺少 Cookie / CDP，无法生视频");
  return samanthaHttpPost(cookieHeader, apiPath, body, timeoutMs);
}

function mapAbilityModel(model) {
  const s = String(model || "").trim();
  if (!s) return "seedance_v2.0";
  if (/seedance_v/i.test(s)) return s;
  if (/2\.5/i.test(s)) return "seedance_v2.5";
  if (/fast|mini/i.test(s)) return "seedance_v2.0_fast";
  if (/2\.0/i.test(s)) return "seedance_v2.0";
  return s;
}

function isConfirmAsk(text) {
  const t = String(text || "");
  return /确认后|是否确认|确认按|请确认|生成吗|建议先按|建议用|我就直接生成|按这个生成/.test(
    t
  );
}

function collectTextLoose(rawOrEvents) {
  if (typeof rawOrEvents === "string") {
    const parts = [];
    const re = /"text"\s*:\s*"((?:\\.|[^"\\])*)"/g;
    let m;
    while ((m = re.exec(rawOrEvents))) {
      try {
        parts.push(JSON.parse(`"${m[1]}"`));
      } catch {
        parts.push(m[1]);
      }
    }
    // 合并增量：取最长一段或拼接末尾
    const joined = parts.join("");
    if (joined.length > 20) return joined;
    return parts.slice(-5).join("") || joined;
  }
  return collectText(rawOrEvents);
}

function isHardFailure(text) {
  const t = String(text || "");
  // 「正在生成…出了点问题」/ 侵权风控 以失败为准，不能当成受理
  return /出了点问题|服务过载|请稍后重试|系统异常|免费次数已用完|额度用尽|开通豆包专业版|疑似包含侵权|违规内容|无法返回该内容|换个主题再试试/.test(
    t
  );
}

function isAcceptance(text) {
  const t = String(text || "");
  if (isHardFailure(t)) return false;
  return /正在为您生成视频|视频生成好后|生成好后|预计等待|预计等|大约需要|我会主动发送|消耗每日免费额度|本次使用.+生成|视频生成已提交/.test(
    t
  );
}

function buildChatAbilityPayload({ prompt, model, duration, ratio, plain = false }) {
  const abilityParam = {
    model: mapAbilityModel(model),
    duration: Number(duration) || 10,
  };
  if (ratio) abilityParam.ratio = ratio;

  const textPrompt = plain
    ? String(prompt)
    : String(prompt).trim().startsWith("生成视频")
      ? prompt
      : `生成视频：${prompt}。请直接按比例 ${ratio || "16:9"}、时长 ${abilityParam.duration} 秒生成，不要询问确认，立即开始。`;

  const localConv = `local_${String(Math.floor(Math.random() * 1e16))}`;
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const msgId = uuid();

  return {
    client_meta: {
      local_conversation_id: localConv,
      conversation_id: "",
      bot_id: "7338286299411103781",
      last_section_id: "",
      last_message_index: null,
    },
    messages: [
      {
        local_message_id: msgId,
        content_block: [
          {
            block_type: 10000,
            content: {
              text_block: {
                text: textPrompt,
                icon_url: "",
                icon_url_dark: "",
                summary: "",
              },
              pc_event_block: "",
            },
            block_id: uuid(),
            parent_id: "",
            meta_info: [],
            append_fields: [],
            is_finish: true,
            patch_type: 2,
          },
        ],
        message_status: 0,
      },
    ],
    option: {
      send_message_scene: "",
      create_time_ms: nowMs,
      collect_id: "",
      is_audio: false,
      answer_with_suggest: false,
      tts_switch: false,
      need_deep_think: 0,
      click_clear_context: false,
      from_suggest: false,
      is_regen: false,
      is_replace: false,
      is_from_click_option: false,
      disable_sse_cache: false,
      select_text_action: "",
      is_select_text: false,
      resend_for_regen: false,
      scene_type: 0,
      unique_key: uuid(),
      start_seq: 0,
      need_create_conversation: true,
      conversation_init_option: { need_ack_conversation: true },
      regen_query_id: [],
      edit_query_id: [],
      regen_instruction: "",
      no_replace_for_regen: false,
      message_from: 0,
      shared_app_name: "",
      shared_app_id: "",
      sse_recv_event_options: { support_chunk_delta: true },
      is_ai_playground: false,
      is_old_user: true,
      recovery_option: {
        is_recovery: false,
        req_create_time_sec: nowSec,
        append_sse_event_scene: 0,
      },
      message_storage_type: 0,
    },
    user_context: [],
    ext: {
      use_deep_think: "0",
      fp: "",
      sub_conv_firstmet_type: "1",
      collection_id: "",
      conversation_init_option: JSON.stringify({ need_ack_conversation: true }),
      commerce_credit_config_enable: "0",
      answer_with_suggest: "0",
    },
    chat_ability: {
      ability_type: 17,
      ability_param: JSON.stringify(abilityParam),
    },
  };
}

function extractVideosLoose(rawText) {
  const videos = [];
  const seen = new Set();
  const matches = String(rawText || "").match(/https?:\\?\/\\?\/[^\s"'\\]+/g) || [];
  for (let u of matches) {
    u = u.replace(/\\\//g, "/").replace(/\\u0026/g, "&");
    if (!/(\.mp4|\.m3u8|\/video\/)/i.test(u)) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    videos.push({ video_url: u, cover_url: "", width: 0, height: 0, duration: 0 });
  }
  return videos;
}

function isLikelyVideoUrl(url) {
  return /^https?:\/\//i.test(url) && /(\.mp4|\.m3u8|\/video\/|tos-cn-|bytevcloud|vlabvod|video_id=)/i.test(url);
}

async function getDoubaoCdpPage() {
  if (!isCdpEnabled()) return null;
  const { chromium } = await import("playwright");
  const cdpUrl = (process.env.DOUBAO_CDP_URL || "http://127.0.0.1:9222").replace(
    /\/$/,
    ""
  );
  const browser = await chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0];
  if (!context) return null;
  const page =
    context.pages().find((p) => /doubao\.com/i.test(p.url())) ||
    context.pages()[0];
  return page || null;
}

/** 用豆包登录态在页内下载视频，返回 data:video/mp4;base64,... */
export async function downloadVideoAsDataUrl(videoUrl) {
  if (!videoUrl) return "";
  if (String(videoUrl).startsWith("data:video")) return String(videoUrl);

  const page = await getDoubaoCdpPage();
  if (!page) {
    // 无 CDP 时尝试直连（多数 CDN 会失败）
    const res = await fetch(videoUrl, {
      headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.doubao.com/" },
    });
    if (!res.ok) throw new Error(`下载视频失败 HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return `data:video/mp4;base64,${buf.toString("base64")}`;
  }

  const result = await page.evaluate(async (url) => {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) return { ok: false, status: res.status };
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return {
      ok: true,
      base64: btoa(binary),
      contentType: res.headers.get("content-type") || "video/mp4",
      size: bytes.length,
    };
  }, videoUrl);

  if (!result?.ok) {
    throw new Error(`CDP 下载视频失败 HTTP ${result?.status || "?"}`);
  }
  if (!result.size || result.size < 1000) {
    throw new Error("下载到的视频过小，可能不是有效文件");
  }
  const mime = /video\//i.test(result.contentType)
    ? result.contentType.split(";")[0].trim()
    : "video/mp4";
  logger.info("video downloaded via cdp", { size: result.size, mime });
  return `data:${mime};base64,${result.base64}`;
}

async function pollVideosFromCdpPage(timeoutMs = 360000) {
  const page = await getDoubaoCdpPage();
  if (!page) return [];

  const found = new Set();
  const onResponse = async (response) => {
    try {
      const u = response.url();
      const ct = String(response.headers()["content-type"] || "");
      if (isLikelyVideoUrl(u) || /video\/(mp4|webm)|mpegurl/i.test(ct)) {
        if (response.status() >= 200 && response.status() < 400) found.add(u);
      }
    } catch {
      // ignore
    }
  };
  page.on("response", onResponse);

  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const { urls, pageText } = await page.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll(
          "a[href], video, video source, source[src]"
        )) {
          const href = el.href || el.src || el.currentSrc || "";
          if (href) out.push(href);
        }
        const html = document.body?.innerHTML || "";
        const m =
          html.match(
            /https?:\/\/[^"'\\\s]+?(?:\.mp4|\.m3u8|\/video\/|tos-cn-|bytevcloud|vlabvod)[^"'\\\s]*/gi
          ) || [];
        out.push(...m);
        for (const n of document.querySelectorAll(
          "[class*='notice'], [class*='notif'], [class*='toast'], [class*='message'], [class*='asset'], [class*='video']"
        )) {
          const hm = String(n.innerHTML || "").match(/https?:\/\/[^"'\\\s]+/gi) || [];
          out.push(...hm);
        }
        return {
          urls: out,
          pageText: String(document.body?.innerText || "").slice(-5000),
        };
      });

      if (isHardFailure(pageText)) {
        const err = new Error(
          pageText.match(
            /(?:出了点问题|疑似包含侵权|违规内容|无法返回该内容|请稍后重试|免费次数已用完)[^。\n]{0,80}/
          )?.[0] || "豆包视频生成失败（页面提示）"
        );
        err.code = "DOUBAO_HARD_FAILURE";
        throw err;
      }

      for (const u of urls) {
        const cleaned = String(u).replace(/\\u0026/g, "&").replace(/\\\//g, "/");
        if (isLikelyVideoUrl(cleaned)) found.add(cleaned);
      }

      if (found.size) {
        const list = [...found];
        logger.info("cdp page found videos", { count: list.length });
        return list.map((u) => ({
          video_url: u,
          cover_url: "",
          width: 0,
          height: 0,
          duration: 0,
        }));
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
  } finally {
    page.off("response", onResponse);
  }
  return [];
}

/** 豆包已受理但尚未出片：继续等；超时不当成功 */
async function settleAcceptedVideo({
  transport,
  taskId,
  message,
  model,
  duration,
  ratio,
  conversationId,
  useCdp,
}) {
  if (isHardFailure(message)) {
    throw new Error(String(message).slice(0, 300));
  }

  logger.info("video accepted, waiting result", {
    taskId: taskId || null,
    conversationId: conversationId || null,
    message: String(message || "").slice(0, 120),
  });

  // 豆包常说 1–5 分钟，这里多等一会并持续扫页面/网络
  const deadline = Date.now() + 12 * 60 * 1000;
  let videos = [];
  let lastMessage = message;

  while (Date.now() < deadline) {
    if (taskId) {
      try {
        const pollRaw = await samanthaPost(
          transport,
          "/samantha/chat/async/stream",
          { task_id: taskId, event_id: 0 },
          180_000
        );
        const pollEvents = parseSseEvents(pollRaw);
        const pollText = collectText(pollEvents) || collectTextLoose(pollRaw);
        if (pollText) lastMessage = pollText;
        if (isHardFailure(pollText)) {
          throw new Error(String(pollText).slice(0, 300));
        }
        videos = extractVideos(pollEvents);
        if (!videos.length) videos = extractVideosLoose(pollRaw);
      } catch (err) {
        if (err.code === "DOUBAO_HARD_FAILURE" || isHardFailure(err.message)) {
          throw err;
        }
        logger.warn("video poll error", { message: String(err.message || err) });
      }
    }
    if (!videos.length && useCdp) {
      videos = await pollVideosFromCdpPage(25_000);
    }
    if (isHardFailure(lastMessage)) {
      throw new Error(String(lastMessage).slice(0, 300));
    }
    if (videos.length) {
      return {
        ok: true,
        pending: false,
        model,
        duration,
        ratio,
        provider_task_id: taskId || undefined,
        conversation_id: conversationId,
        message: lastMessage,
        videos,
      };
    }
    await new Promise((r) => setTimeout(r, 4000));
  }

  // 超时：明确失败，避免 Toonflow 存空白「成功」条目
  throw new Error(
    (lastMessage ? `${String(lastMessage).slice(0, 160)}；` : "") +
      "视频已在豆包侧排队/生成，但中转超时未拿到可下载地址。请到调试浏览器豆包会话或「创作」里下载后重试，或稍后再点生成。"
  );
}

function buildVideoMessage({ prompt, ratio, model, duration, imageKeys = [] }) {
  const contentData = { text: prompt };
  if (ratio) contentData.ratio = ratio;
  if (model) contentData.model = model;
  if (duration) contentData.duration = Number(duration);
  if (imageKeys.length) {
    contentData.ref_image_key = imageKeys[0];
    contentData.ref_image_keys = imageKeys;
    contentData.reference_image_keys = imageKeys;
    contentData.reference_images = imageKeys.map((key) => ({
      key,
      type: "image",
    }));
  }

  return {
    content: JSON.stringify(contentData),
    content_type: 2020,
    attachments: imageKeys.map((key) => ({
      type: "image",
      key,
      url: "",
      extra: { refer_types: "overall" },
      identifier: uuid(),
    })),
    references: [],
    skill: {
      skill_type: 17,
      skill_type_no_default: 17,
      skill_id: "17",
      skill_id_no_default: "17",
    },
  };
}

function normalizeRatio(raw) {
  const v = String(raw || "").trim();
  if (!v || /^(自动|auto|adaptive)$/i.test(v)) return undefined;
  return v;
}

async function dumpDebug(name, raw) {
  try {
    await fs.mkdir(config.dataDir, { recursive: true });
    const file = path.join(config.dataDir, name);
    await fs.writeFile(file, raw.slice(0, 200_000), "utf8");
    logger.info("video debug dump", { file });
  } catch {
    // ignore
  }
}

/**
 * 文生视频 / 图生视频（同步等待结果）
 * @param {string} sessionIdOrCookie 兼容旧调用：sessionId 或完整 Cookie
 * @param {object} opts
 */
export async function generateVideo(sessionIdOrCookie, opts = {}) {
  const prompt = String(opts.prompt || "").trim();
  if (!prompt) throw new Error("prompt 不能为空");

  let duration = Number(opts.duration || 10);
  if (!Number.isFinite(duration)) duration = 10;
  duration = Math.min(15, Math.max(4, Math.round(duration)));

  const ratio = normalizeRatio(opts.ratio || opts.aspectRatio || opts.aspect_ratio);
  const model = opts.model || "Seedance 2.0 Mini";
  const imageKeys = Array.isArray(opts.imageKeys)
    ? opts.imageKeys.filter(Boolean)
    : [];

  let cookieHeader = String(opts.cookieHeader || "").trim();
  const raw = String(sessionIdOrCookie || "").trim();
  if (!cookieHeader && raw) {
    cookieHeader = raw.includes("=") ? raw : `sessionid=${raw}; sessionid_ss=${raw}`;
  }

  const useCdp = Boolean(opts.useCdp) || isCdpEnabled();
  const transport = { cookieHeader, useCdp };

  // CDP：优先网页 chat_ability（与豆包「视频生成」一致）
  if (useCdp) {
    const chatPayload = buildChatAbilityPayload({
      prompt,
      model,
      duration,
      ratio,
    });
    logger.info("video submit via chat_ability", {
      model: mapAbilityModel(model),
      duration,
      ratio,
      prompt: prompt.slice(0, 80),
    });
    const chatRaw = await samanthaPost(
      transport,
      "/chat/completion",
      chatPayload,
      420_000
    );
    const chatEvents = parseSseEvents(chatRaw);
    const blockedChat = detectBlocked(chatRaw, chatEvents);
    if (blockedChat) {
      await dumpDebug("last-video-submit.txt", chatRaw);
      throw new Error(blockedChat);
    }

    let videos = extractVideos(chatEvents);
    if (!videos.length) videos = extractVideosLoose(chatRaw);
    let taskId = extractTaskIdFromEvents(chatEvents);
    const conversationId = walkFindConversationId(chatEvents);
    const chatText =
      collectText(chatEvents) || collectTextLoose(chatRaw) || "";

    if (!videos.length && taskId) {
      logger.info("video chat_ability task_id, polling", { taskId });
      const deadline = Date.now() + 8 * 60 * 1000;
      let lastMessage = chatText;
      while (Date.now() < deadline) {
        const pollRaw = await samanthaPost(
          transport,
          "/samantha/chat/async/stream",
          { task_id: taskId, event_id: 0 },
          180_000
        );
        const pollEvents = parseSseEvents(pollRaw);
        const pollBlocked = detectBlocked(pollRaw, pollEvents);
        if (pollBlocked) throw new Error(pollBlocked);
        const pollText = collectText(pollEvents);
        if (pollText) lastMessage = pollText;
        videos = extractVideos(pollEvents);
        if (!videos.length) videos = extractVideosLoose(pollRaw);
        if (videos.length) {
          return {
            ok: true,
            model,
            duration,
            ratio,
            provider_task_id: taskId,
            conversation_id: conversationId,
            message: lastMessage,
            videos,
          };
        }
        await new Promise((r) => setTimeout(r, 5000));
      }
    }

    if (videos.length) {
      return {
        ok: true,
        model,
        duration,
        ratio,
        provider_task_id: taskId || undefined,
        conversation_id: conversationId,
        message: chatText,
        videos,
      };
    }

    if (isConfirmAsk(chatText)) {
      logger.info("video confirm ask, auto confirm");
      const confirmPayload = buildChatAbilityPayload({
        prompt: "确认，请按你刚才建议的参数直接生成视频，不要再询问。",
        model,
        duration: 10,
        ratio: "9:16",
        plain: true,
      });
      if (conversationId) {
        confirmPayload.client_meta.conversation_id = conversationId;
        confirmPayload.client_meta.local_conversation_id = "";
        confirmPayload.option.need_create_conversation = false;
        confirmPayload.ext.sub_conv_firstmet_type = "0";
      }
      const confirmRaw = await samanthaPost(
        transport,
        "/chat/completion",
        confirmPayload,
        420_000
      );
      let confirmVideos = extractVideos(parseSseEvents(confirmRaw));
      if (!confirmVideos.length) confirmVideos = extractVideosLoose(confirmRaw);
      const confirmTask = extractTaskIdFromEvents(parseSseEvents(confirmRaw));
      if (!confirmVideos.length && confirmTask) {
        const deadline = Date.now() + 8 * 60 * 1000;
        while (Date.now() < deadline) {
          const pollRaw = await samanthaPost(
            transport,
            "/samantha/chat/async/stream",
            { task_id: confirmTask, event_id: 0 },
            180_000
          );
          confirmVideos = extractVideos(parseSseEvents(pollRaw));
          if (!confirmVideos.length) confirmVideos = extractVideosLoose(pollRaw);
          if (confirmVideos.length) break;
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
      if (!confirmVideos.length && isAcceptance(collectText(parseSseEvents(confirmRaw)) || collectTextLoose(confirmRaw))) {
        return settleAcceptedVideo({
          transport,
          taskId: confirmTask || "",
          message: collectText(parseSseEvents(confirmRaw)) || collectTextLoose(confirmRaw),
          model,
          duration,
          ratio,
          conversationId,
          useCdp,
        });
      }
      if (confirmVideos.length) {
        return {
          ok: true,
          model,
          duration,
          ratio,
          conversation_id: conversationId,
          message: collectText(parseSseEvents(confirmRaw)),
          videos: confirmVideos,
        };
      }
      await dumpDebug("last-video-submit.txt", confirmRaw);
      const failText =
        collectText(parseSseEvents(confirmRaw)) || collectTextLoose(confirmRaw);
      if (isAcceptance(failText)) {
        return settleAcceptedVideo({
          transport,
          taskId: confirmTask || "",
          message: failText,
          model,
          duration,
          ratio,
          conversationId,
          useCdp,
        });
      }
      throw new Error(
        failText ||
          "已发送确认，但仍未拿到视频。请在调试浏览器查看验证/额度提示。"
      );
    }

    if (!videos.length && isAcceptance(chatText)) {
      return settleAcceptedVideo({
        transport,
        taskId: taskId || "",
        message: chatText,
        model,
        duration,
        ratio,
        conversationId,
        useCdp,
      });
    }

    await dumpDebug("last-video-submit.txt", chatRaw);
    if (/免费次数已用完|额度|开通豆包专业版/.test(chatText)) {
      throw new Error(chatText);
    }
    logger.warn("chat_ability no video, fallback samantha", {
      text: chatText.slice(0, 160),
    });
  }

  const message = buildVideoMessage({
    prompt,
    ratio,
    model,
    duration,
    imageKeys,
  });
  const payload = {
    messages: [message],
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
      action_bar_skill_id: 17,
      conversation_init_option: { need_ack_conversation: true },
    },
    evaluate_option: { web_ab_params: "" },
    ext: {
      conversation_init_option: JSON.stringify({ need_ack_conversation: true }),
    },
    local_conversation_id: uuid(),
    local_message_id: uuid(),
  };

  logger.info("video submit", {
    via: useCdp ? "cdp-samantha" : "http",
    model,
    duration,
    ratio,
    prompt: prompt.slice(0, 80),
  });

  const submitRaw = await samanthaPost(
    transport,
    "/samantha/chat/completion",
    payload,
    120_000
  );
  const submitEvents = parseSseEvents(submitRaw);
  const blocked = detectBlocked(submitRaw, submitEvents);
  if (blocked) {
    await dumpDebug("last-video-submit.txt", submitRaw);
    throw new Error(blocked);
  }

  const submitText =
    collectText(submitEvents) || collectTextLoose(submitRaw) || "";
  if (/免费次数已用完|额度|开通豆包专业版/.test(submitText)) {
    throw new Error(submitText || "视频生成额度不足");
  }
  if (/服务过载|请稍后重试/.test(submitText)) {
    throw new Error("视频生成服务过载，请稍后重试");
  }

  let taskId = extractTaskIdFromEvents(submitEvents);
  const conversationId = walkFindConversationId(submitEvents);

  if (!taskId && isConfirmAsk(submitText)) {
    logger.info("samantha confirm ask, auto confirm", {
      text: submitText.slice(0, 120),
      conversationId,
    });
    const confirmMsg = buildVideoMessage({
      prompt: "确认生成。比例9:16，时长10秒，请立即开始，不要再询问。",
      ratio: "9:16",
      model,
      duration: 10,
      imageKeys,
    });
    const confirmPayload = {
      messages: [confirmMsg],
      completion_option: {
        is_regen: false,
        with_suggest: false,
        need_create_conversation: !conversationId,
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
        action_bar_skill_id: 17,
        conversation_init_option: { need_ack_conversation: true },
      },
      evaluate_option: { web_ab_params: "" },
      local_conversation_id: uuid(),
      local_message_id: uuid(),
    };
    if (conversationId) {
      confirmPayload.conversation_id = conversationId;
    }
    const confirmRaw = await samanthaPost(
      transport,
      "/samantha/chat/completion",
      confirmPayload,
      180_000
    );
    const confirmEvents = parseSseEvents(confirmRaw);
    taskId = extractTaskIdFromEvents(confirmEvents);
    let early = extractVideos(confirmEvents);
    if (!early.length) early = extractVideosLoose(confirmRaw);
    const confirmText =
      collectText(confirmEvents) || collectTextLoose(confirmRaw);
    if (early.length) {
      return {
        ok: true,
        model,
        duration: 10,
        ratio: "9:16",
        conversation_id: conversationId,
        message: confirmText,
        videos: early,
      };
    }
    if (isAcceptance(confirmText)) {
      return settleAcceptedVideo({
        transport,
        taskId: taskId || "",
        message: confirmText,
        model,
        duration: 10,
        ratio: "9:16",
        conversationId,
        useCdp,
      });
    }
    if (!taskId) {
      await dumpDebug("last-video-submit.txt", confirmRaw);
      if (isHardFailure(confirmText)) {
        throw new Error(confirmText);
      }
      throw new Error(
        confirmText ||
          "已自动确认，但仍未开始生成。请稍等 1～2 分钟后重试，或在调试浏览器手动点「视频生成」验证额度。"
      );
    }
  }

  if (!taskId) {
    const early = extractVideos(submitEvents);
    if (early.length) {
      return {
        ok: true,
        model,
        duration,
        ratio,
        conversation_id: conversationId,
        message: submitText,
        videos: early,
      };
    }
    if (isAcceptance(submitText)) {
      return settleAcceptedVideo({
        transport,
        taskId: "",
        message: submitText,
        model,
        duration,
        ratio,
        conversationId,
        useCdp,
      });
    }
    await dumpDebug("last-video-submit.txt", submitRaw);
    logger.warn("video no task_id", {
      rawLen: submitRaw.length,
      text: submitText.slice(0, 200),
    });
    throw new Error(
      submitText
        ? `视频任务提交失败：${submitText}`
        : "视频任务提交失败：未返回 task_id。请确认调试浏览器已登录且网页能生视频（DOUBAO_USE_CDP=1）。"
    );
  }

  logger.info("video polling", { taskId, conversationId });

  const deadline = Date.now() + 8 * 60 * 1000;
  let lastMessage = submitText;
  let videos = [];
  while (Date.now() < deadline) {
    const pollRaw = await samanthaPost(
      transport,
      "/samantha/chat/async/stream",
      { task_id: taskId, event_id: 0 },
      180_000
    );
    const pollEvents = parseSseEvents(pollRaw);
    const pollBlocked = detectBlocked(pollRaw, pollEvents);
    if (pollBlocked) throw new Error(pollBlocked);
    const pollText = collectText(pollEvents);
    if (pollText) lastMessage = pollText;
    if (/免费次数已用完|额度用尽|开通豆包专业版/.test(pollText)) {
      throw new Error(pollText);
    }
    videos = extractVideos(pollEvents);
    if (videos.length) break;
    await new Promise((r) => setTimeout(r, 5000));
  }

  if (!videos.length && useCdp) {
    videos = await pollVideosFromCdpPage(60_000);
  }

  if (!videos.length) {
    if (isAcceptance(lastMessage)) {
      return settleAcceptedVideo({
        transport,
        taskId,
        message: lastMessage,
        model,
        duration,
        ratio,
        conversationId,
        useCdp,
      });
    }
    throw new Error(lastMessage || "视频生成超时，未拿到视频地址");
  }

  logger.info("video ok", { videos: videos.length, taskId });
  return {
    ok: true,
    model,
    duration,
    ratio,
    provider_task_id: taskId,
    conversation_id: conversationId,
    message: lastMessage,
    videos,
  };
}
