/**
 * 豆包参考图上传（alice prepare_upload → ImageX → TOS）
 * 返回 storeUri，用作 chat completion attachments[].key
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { getCookieValue } from "./cookie-utils.js";
import { logger } from "./logger.js";
import { config } from "./config.js";

const IMAGEX_REGION = "cn-north-1";
const IMAGEX_SERVICE = "imagex";
const FILE_MAX = 20 * 1024 * 1024;
const PREVIEW_DIR = path.join(config.dataDir, "ref-previews");
const PREVIEW_MAX_KEEP = 80;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32Hex(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return ((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}

function sha256Hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hmac(key, data) {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

function rfc3986Encode(str) {
  return encodeURIComponent(str).replace(
    /[!*'()]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function canonicalQuery(params) {
  return Object.keys(params)
    .sort()
    .map((k) => `${rfc3986Encode(k)}=${rfc3986Encode(params[k] ?? "")}`)
    .join("&");
}

function amzDates(date = new Date()) {
  const pad = (n) => (n < 10 ? "0" + n : String(n));
  const yyyy = date.getUTCFullYear();
  const mm = pad(date.getUTCMonth() + 1);
  const dd = pad(date.getUTCDate());
  const HH = pad(date.getUTCHours());
  const MM = pad(date.getUTCMinutes());
  const SS = pad(date.getUTCSeconds());
  const dateStamp = `${yyyy}${mm}${dd}`;
  return { amzDate: `${dateStamp}T${HH}${MM}${SS}Z`, dateStamp };
}

function buildAuthorization(
  method,
  host,
  path,
  params,
  sessionToken,
  accessKey,
  secretKey,
  opts = {}
) {
  const { amzDate, dateStamp } = amzDates();
  const canonicalQS = canonicalQuery(params);
  const headersMap = { host, "x-amz-date": amzDate };
  if (sessionToken) headersMap["x-amz-security-token"] = sessionToken;
  const payloadHash = opts.payloadHash ?? sha256Hex("");
  if (opts.signContentSha256) headersMap["x-amz-content-sha256"] = payloadHash;
  const headerNames = Object.keys(headersMap).sort();
  const canonicalHeaders = headerNames.map((k) => `${k}:${headersMap[k]}\n`).join("");
  const signedHeaders = headerNames.join(";");
  const canonicalRequest = [
    method,
    path,
    canonicalQS,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const algorithm = "AWS4-HMAC-SHA256";
  const credentialScope = `${dateStamp}/${IMAGEX_REGION}/${IMAGEX_SERVICE}/aws4_request`;
  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const kDate = hmac("AWS4" + secretKey, dateStamp);
  const kRegion = hmac(kDate, IMAGEX_REGION);
  const kService = hmac(kRegion, IMAGEX_SERVICE);
  const kSigning = hmac(kService, "aws4_request");
  const signature = crypto
    .createHmac("sha256", kSigning)
    .update(stringToSign, "utf8")
    .digest("hex");
  const authorization = `${algorithm} Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { authorization, amzDate, payloadHash };
}

function sniffSize(buf, mimeType) {
  try {
    if (buf[0] === 0x89 && buf[1] === 0x50) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) {
          i++;
          continue;
        }
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if ([0xc0, 0xc1, 0xc2].includes(marker)) {
          return {
            height: buf.readUInt16BE(i + 5),
            width: buf.readUInt16BE(i + 7),
          };
        }
        i += 2 + len;
      }
    }
  } catch {
    // ignore
  }
  return { width: 1, height: 1 };
}

function parseImageInput(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  if (/^data:/i.test(raw)) {
    const m = raw.match(/^data:([^;]+);base64,(.+)$/i);
    if (!m) throw new Error("无效的 data URL");
    const mime = m[1] || "image/png";
    const buf = Buffer.from(m[2], "base64");
    const ext = /jpeg|jpg/i.test(mime) ? "jpg" : /webp/i.test(mime) ? "webp" : "png";
    return { buf, mime, ext, name: `ref.${ext}` };
  }
  if (/^https?:\/\//i.test(raw)) {
    return { url: raw };
  }
  // 裸 base64
  const buf = Buffer.from(raw.replace(/\s/g, ""), "base64");
  if (buf.length < 32) return null;
  return { buf, mime: "image/png", ext: "png", name: "ref.png" };
}

async function loadImageBuffer(input) {
  const parsed = parseImageInput(input);
  if (!parsed) return null;
  if (parsed.buf) {
    if (parsed.buf.length > FILE_MAX) throw new Error("参考图超过 20MB");
    return parsed;
  }
  const res = await fetch(parsed.url, {
    headers: { "User-Agent": "Mozilla/5.0", Accept: "image/*" },
  });
  if (!res.ok) throw new Error(`下载参考图失败 HTTP ${res.status}`);
  const ab = await res.arrayBuffer();
  const buf = Buffer.from(ab);
  if (buf.length > FILE_MAX) throw new Error("参考图超过 20MB");
  const ct = res.headers.get("content-type") || "image/png";
  const ext = /jpeg|jpg/i.test(ct) ? "jpg" : /webp/i.test(ct) ? "webp" : "png";
  return { buf, mime: ct.split(";")[0], ext, name: `ref.${ext}` };
}

async function alicePrepareUpload(cookieHeader, resourceType = 2) {
  const csrf =
    getCookieValue(cookieHeader, "passport_csrf_token") ||
    getCookieValue(cookieHeader, "passport_csrf_token_default");
  const headers = {
    Accept: "*/*",
    "Content-Type": "application/json",
    Cookie: cookieHeader,
    Origin: "https://www.doubao.com",
    Referer: "https://www.doubao.com/chat/",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "agw-js-conv": "str",
  };
  if (csrf) headers["x-tt-passport-csrf-token"] = csrf;

  const res = await fetch("https://www.doubao.com/alice/resource/prepare_upload", {
    method: "POST",
    headers,
    body: JSON.stringify({ tenant_id: "5", scene_id: "5", resource_type: resourceType }),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`prepare_upload 非 JSON: ${text.slice(0, 200)}`);
  }
  // 兼容 {code,data} 与直接返回
  const payload = data?.data ?? data;
  if (!payload?.upload_auth_token) {
    throw new Error(`prepare_upload 失败: ${text.slice(0, 300)}`);
  }
  return {
    serviceId: payload.service_id,
    uploadHost: payload.upload_host,
    accessKey: payload.upload_auth_token.access_key,
    secretKey: payload.upload_auth_token.secret_key,
    sessionToken: payload.upload_auth_token.session_token,
  };
}

async function applyImageUpload(auth, fileSize, fileExtension) {
  const params = {
    Action: "ApplyImageUpload",
    Version: "2018-08-01",
    ServiceId: auth.serviceId,
    NeedFallback: "true",
    UploadNum: "1",
    FileSize: String(fileSize),
    FileExtension: fileExtension.startsWith(".") ? fileExtension : `.${fileExtension}`,
  };
  const { authorization, amzDate } = buildAuthorization(
    "GET",
    auth.uploadHost,
    "/",
    params,
    auth.sessionToken,
    auth.accessKey,
    auth.secretKey
  );
  const url = `https://${auth.uploadHost}/?${canonicalQuery(params)}`;
  const res = await fetch(url, {
    headers: {
      "x-amz-date": amzDate,
      "x-amz-security-token": auth.sessionToken,
      "X-Security-Token": auth.sessionToken,
      authorization,
    },
  });
  const body = await res.json();
  const uploadAddress = body?.Result?.UploadAddress;
  const storeInfo = uploadAddress?.StoreInfos?.[0];
  const tosHost = uploadAddress?.UploadHosts?.[0];
  if (!storeInfo?.StoreUri || !storeInfo?.Auth || !tosHost) {
    throw new Error(`ApplyImageUpload 失败: ${JSON.stringify(body).slice(0, 400)}`);
  }
  return {
    storeUri: storeInfo.StoreUri,
    auth: storeInfo.Auth,
    tosHost,
  };
}

async function uploadToTos(tosHost, storeUri, authHeader, fileData, mimeType) {
  const url = `https://${tosHost}/upload/v1/${storeUri}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-CRC32": crc32Hex(fileData),
      "Content-Type": mimeType || "application/octet-stream",
    },
    body: fileData,
  });
  const body = await res.json().catch(() => ({}));
  const code = body?.code;
  if (!res.ok || (code !== 2000 && String(code) !== "2000")) {
    throw new Error(`TOS upload failed: HTTP ${res.status} code=${code}`);
  }
}

async function commitImageUpload(auth, storeUri, storeAuth, tosHost) {
  const params = {
    Action: "CommitImageUpload",
    Version: "2018-08-01",
    ServiceId: auth.serviceId,
  };
  const sessionKeyObj = {
    accountType: "ImageX",
    appId: "",
    bizType: "",
    fileType: "image",
    legal: "",
    storeInfos: JSON.stringify([
      {
        StoreUri: storeUri,
        Auth: storeAuth,
        UploadID: "",
        UploadHeader: null,
        StorageHeader: null,
      },
    ]),
    uploadHost: tosHost,
    uri: storeUri,
    userId: "",
  };
  const bodyStr = JSON.stringify({
    SessionKey: Buffer.from(JSON.stringify(sessionKeyObj)).toString("base64"),
  });
  const payloadHash = sha256Hex(bodyStr);
  const { authorization, amzDate } = buildAuthorization(
    "POST",
    auth.uploadHost,
    "/",
    params,
    auth.sessionToken,
    auth.accessKey,
    auth.secretKey,
    { payloadHash, signContentSha256: true }
  );
  const url = `https://${auth.uploadHost}/?${canonicalQuery(params)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "x-amz-date": amzDate,
      "x-amz-security-token": auth.sessionToken,
      "x-amz-content-sha256": payloadHash,
      "content-type": "application/json",
      authorization,
    },
    body: bodyStr,
  });
  const body = await res.json().catch(() => ({}));
  const uriStatus = body?.Result?.Results?.[0]?.UriStatus;
  if (!res.ok || (uriStatus !== 2000 && String(uriStatus) !== "2000")) {
    logger.warn("CommitImageUpload soft-fail", {
      status: res.status,
      uriStatus,
    });
  }
  return body;
}

async function saveRefPreview(buf, ext = "jpg") {
  try {
    await fsp.mkdir(PREVIEW_DIR, { recursive: true });
    const safeExt = /^(jpe?g|png|webp)$/i.test(ext) ? ext.replace(/jpeg/i, "jpg") : "jpg";
    const name = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${safeExt}`;
    await fsp.writeFile(path.join(PREVIEW_DIR, name), buf);
    // 简单清理旧预览，避免占满磁盘
    try {
      const files = (await fsp.readdir(PREVIEW_DIR))
        .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
        .sort();
      if (files.length > PREVIEW_MAX_KEEP) {
        for (const f of files.slice(0, files.length - PREVIEW_MAX_KEEP)) {
          await fsp.unlink(path.join(PREVIEW_DIR, f)).catch(() => {});
        }
      }
    } catch {
      // ignore cleanup
    }
    return `/admin/ref-preview/${name}`;
  } catch (err) {
    logger.warn("ref preview save failed", { message: String(err.message || err) });
    return null;
  }
}

/**
 * 上传单张图，返回 { key, name, width, height, preview }
 */
export async function uploadOneImage(cookieHeader, imageInput) {
  const file = await loadImageBuffer(imageInput);
  if (!file) throw new Error("空参考图");
  const auth = await alicePrepareUpload(cookieHeader, 2);
  const apply = await applyImageUpload(auth, file.buf.length, `.${file.ext}`);
  await uploadToTos(apply.tosHost, apply.storeUri, apply.auth, file.buf, file.mime);
  try {
    await commitImageUpload(auth, apply.storeUri, apply.auth, apply.tosHost);
  } catch (err) {
    logger.warn("commit skip", { message: String(err.message || err) });
  }
  const size = sniffSize(file.buf, file.mime);
  const preview = await saveRefPreview(file.buf, file.ext);
  logger.info("ref image uploaded", {
    key: String(apply.storeUri).slice(0, 80),
    bytes: file.buf.length,
    w: size.width,
    h: size.height,
    preview,
    previews: preview ? [preview] : [],
  });
  return {
    key: apply.storeUri,
    name: file.name,
    width: size.width || 1,
    height: size.height || 1,
    preview,
  };
}

/**
 * 批量上传；失败的单张跳过（至少保住其余）
 */
export async function uploadReferenceImages(cookieHeader, images = [], max = 6) {
  const list = (images || []).filter(Boolean).slice(0, max);
  const out = [];
  for (let i = 0; i < list.length; i++) {
    try {
      const ref = await uploadOneImage(cookieHeader, list[i]);
      out.push(ref);
    } catch (err) {
      logger.warn("ref image upload failed", {
        index: i + 1,
        message: String(err.message || err).slice(0, 200),
      });
    }
  }
  return out;
}

export function getRefPreviewDir() {
  return PREVIEW_DIR;
}

export function buildAttachments(uploaded = [], opts = {}) {
  // 与网页/free-api 同步路径一致：type=image + refer_types
  const names = Array.isArray(opts.names) ? opts.names : [];
  return uploaded.map((u, i) => ({
    type: "image",
    key: u.key,
    identifier: crypto.randomUUID(),
    name: names[i] || u.name || `reference-${i + 1}.png`,
    file_review_state: 3,
    file_parse_state: 3,
    option: { width: u.width || 1, height: u.height || 1 },
    extra: { refer_types: "overall" },
  }));
}

const CN_NUM = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

function toFigId(raw) {
  const s = String(raw || "").trim();
  if (/^\d+$/.test(s)) return Number(s);
  if (CN_NUM[s] != null) return CN_NUM[s];
  return NaN;
}

function canonicalizeAtFigs(text) {
  let t = String(text || "");
  t = t.replace(/[@＠]?\s*\[\s*图片\s*(\d+)\s*\]/gi, "@图$1");
  t = t.replace(/[@＠]\s*图片\s*(\d+)/gi, "@图$1");
  t = t.replace(/[@＠]\s*图\s*(\d+)/gi, "@图$1");
  t = t.replace(/(^|[\s，,。；;\n])图\s*([一二三四五六七八九十]|\d+)\s*为/g, (_, p, n) => {
    const id = toFigId(n);
    return Number.isFinite(id) ? `${p}@图${id} 为` : `${p}图${n}为`;
  });
  return t;
}

function toDoubaoFigTag(slot) {
  // 豆包网页/Toonflow 原生占位是「@图片N」，比「@图N」绑定更稳
  return `@图片${slot}`;
}

/**
 * 从「@图N 为江彻角色」类图例解析身份。
 * @returns {Map<number, { label: string, name: string, kind: string }>}
 */
export function extractRefLegend(prompt) {
  const text = canonicalizeAtFigs(prompt);
  const map = new Map();
  const re = /@图(\d+)\s*为\s*([^@\n，,。；;]{1,32}?)(?=\s*@图|\s*[，,]|\s*$)/g;
  for (const m of text.matchAll(re)) {
    const id = Number(m[1]);
    if (!Number.isFinite(id) || map.has(id)) continue;
    const label = String(m[2] || "").trim();
    let kind = "ref";
    if (/角色|人物|演员/.test(label)) kind = "character";
    else if (/场景|环境|背景|办公室|室内|室外/.test(label)) kind = "scene";
    else if (/道具|物品|文件|袋|器材/.test(label)) kind = "prop";
    const name = label
      .replace(/(角色|人物|演员|场景|环境|背景|道具|物品)$/g, "")
      .trim() || label;
    map.set(id, { label, name, kind });
  }
  return map;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 角色名是否仅作为「工位/座位」地点出现（本人未入画） */
function isLocationOnlyCharacter(sceneText, name) {
  if (!name) return false;
  const nm = escapeRegExp(name);
  const nameHits = [...String(sceneText).matchAll(new RegExp(nm, "g"))];
  if (!nameHits.length) return false;
  const locHits = [
    ...String(sceneText).matchAll(
      new RegExp(`${nm}的?(工位|座位|办公桌|工位桌|桌面|位置)`, "g")
    ),
  ];
  return locHits.length > 0 && locHits.length >= nameHits.length;
}

/**
 * 规划附件顺序：画面动作主角的参考图排到第 1 张。
 * Seedream 多参考时第一张人物脸极易「吞噬」其他角色，必须让主角脸在前。
 *
 * @returns {{
 *   uploadOrder: number[],
 *   assetToSlot: Map<number, number>,
 *   actors: {slot:number,name:string}[],
 *   locationOnly: {slot:number,name:string}[],
 *   legendBySlot: Map<number,{label:string,name:string,kind:string}>,
 *   seen: number[],
 * }}
 */
function planAttachmentOrder(text, n, legendByAsset) {
  const seen = [];
  for (const m of text.matchAll(/@图(\d+)/g)) {
    const id = Number(m[1]);
    if (!seen.includes(id)) seen.push(id);
  }
  const assetIds = seen.slice(0, n);
  while (assetIds.length < n) {
    // 提示词没写全时，按 1..n 补齐
    const next = assetIds.length + 1;
    if (!assetIds.includes(next)) assetIds.push(next);
    else break;
  }

  const sceneBody = text.includes("【画面】")
    ? text.slice(text.indexOf("【画面】"))
    : text;

  const actors = [];
  const locChars = [];
  const scenes = [];
  const props = [];
  const other = [];

  assetIds.forEach((assetId, uploadIdx) => {
    const info = legendByAsset.get(assetId) || {
      label: `图${assetId}`,
      name: `图${assetId}`,
      kind: "ref",
    };
    const item = { assetId, uploadIdx, info };
    if (info.kind === "character") {
      if (isLocationOnlyCharacter(sceneBody, info.name)) locChars.push(item);
      else actors.push(item);
    } else if (info.kind === "scene") scenes.push(item);
    else if (info.kind === "prop") props.push(item);
    else other.push(item);
  });

  actors.sort((a, b) => {
    const ia = sceneBody.indexOf(a.info.name);
    const ib = sceneBody.indexOf(b.info.name);
    return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
  });

  // 仅地点角色：仍保留参考图（丢掉会导致模型把第二人画成主角脸）。
  // 只在文案里标注「不入画」；附件顺序：动作主角 → 其他角色 → 场景 → 道具。
  const ordered = [...actors, ...locChars, ...scenes, ...props, ...other];
  const droppedLoc = [];
  const used = new Set(ordered.map((o) => o.uploadIdx));
  for (let i = 0; i < n; i++) {
    if (!used.has(i)) {
      ordered.push({
        assetId: assetIds[i] ?? i + 1,
        uploadIdx: i,
        info: legendByAsset.get(assetIds[i]) || {
          label: `图${i + 1}`,
          name: `图${i + 1}`,
          kind: "ref",
        },
      });
    }
  }

  const finalItems = ordered.slice(0, n);
  const uploadOrder = finalItems.map((o) => o.uploadIdx);
  const assetToSlot = new Map();
  /** @type {Map<number, { label: string, name: string, kind: string }>} */
  const legendBySlot = new Map();
  finalItems.forEach((o, i) => {
    const slot = i + 1;
    assetToSlot.set(o.assetId, slot);
    legendBySlot.set(slot, o.info);
  });

  return {
    uploadOrder,
    assetToSlot,
    actors: actors.map((a) => ({
      slot: assetToSlot.get(a.assetId),
      name: a.info.name,
    })),
    locationOnly: locChars.map((a) => ({
      slot: assetToSlot.get(a.assetId),
      name: a.info.name,
      dropped: false,
    })),
    legendBySlot,
    seen,
    droppedUploadIdx: [],
  };
}

/**
 * 把 Toonflow / 中文占位统一成豆包附件序号。
 * - 输出统一为 @图片N（豆包原生）
 * - 多角色时把「画面动作主角」的参考图排到附件第 1 张，减轻第一张脸吞噬
 * - 「@图片N 某某工位」改为仅地点，避免把角色脸绑到家具上
 *
 * returnMeta 时附带 uploadOrder：caller 须按此重排 uploaded[] 再建 attachments。
 */
export function normalizeRefPrompt(prompt, attachmentCount, opts = {}) {
  let text = canonicalizeAtFigs(prompt);
  const legendByAsset = extractRefLegend(text);

  const n = Number(attachmentCount) || 0;
  if (n <= 0) {
    if (opts.returnMeta) {
      return {
        text,
        names: [],
        legendBySlot: new Map(),
        characters: [],
        uploadOrder: [],
        locationOnly: [],
      };
    }
    return text;
  }

  const plan = planAttachmentOrder(text, n, legendByAsset);
  const {
    uploadOrder,
    assetToSlot,
    actors,
    locationOnly,
    legendBySlot,
    seen,
    droppedUploadIdx = [],
  } = plan;

  const attachedCount = uploadOrder.length;
  const droppedAssets = new Set();
  // uploadIdx -> assetId from first-seen order
  const seenAssets = [];
  for (const m of text.matchAll(/@图(\d+)/g)) {
    const id = Number(m[1]);
    if (!seenAssets.includes(id)) seenAssets.push(id);
  }
  for (const idx of droppedUploadIdx) {
    if (seenAssets[idx] != null) droppedAssets.add(seenAssets[idx]);
  }
  for (const loc of locationOnly) {
    if (loc.dropped) {
      // name-based: find asset id from legend
      for (const [aid, info] of legendByAsset) {
        if (info.name === loc.name) droppedAssets.add(aid);
      }
    }
  }

  text = text.replace(/@图(\d+)/g, (_, raw) => {
    const id = Number(raw);
    if (droppedAssets.has(id)) return ""; // 仅地点角色：去掉 @，避免绑定已丢弃附件
    const slot = assetToSlot.get(id);
    return slot ? toDoubaoFigTag(slot) : "（未关联参考图，按文字）";
  });
  text = text.replace(/[ \t]{2,}/g, " ");
  // 去掉因丢弃附件而残留的「为江彻角色」图例碎片
  for (const loc of locationOnly) {
    if (!loc?.dropped || !loc.name) continue;
    const nm = escapeRegExp(loc.name);
    text = text.replace(
      new RegExp(`(?:^|[，,\\s])为\\s*${nm}(?:角色|人物)?(?=[，,\\s]|$)`, "g"),
      `，「${loc.name}」本镜不入画`
    );
  }
  text = text.replace(/^[，,\s]+/gm, "");

  // 「@图片1 江彻工位」→ 仅地点（若仍残留）
  text = text.replace(
    /@图片(\d+)\s*([\u4e00-\u9fffA-Za-z0-9]{1,12}?)(的)?(工位|座位|办公桌|工位桌|桌面)/g,
    (_, slot, who, _de, place) => {
      const info = legendBySlot.get(Number(slot));
      const nm = info?.name || who;
      return `「${nm}」的${place}（仅地点，禁止绘制「${nm}」的脸或身体；严禁把 ${toDoubaoFigTag(slot)} 的外貌用到其他角色）`;
    }
  );
  // 无 @ 的「江彻工位」也标成仅地点
  for (const loc of locationOnly) {
    if (!loc?.name) continue;
    const nm = escapeRegExp(loc.name);
    text = text.replace(
      new RegExp(`(?<!「)${nm}的?(工位|座位|办公桌|工位桌|桌面)`, "g"),
      `「${loc.name}」的$1（仅地点，禁止绘制「${loc.name}」面部或身体入画）`
    );
  }

  if (!/@图片\d/.test(text) && attachedCount > 0) {
    const map = Array.from({ length: attachedCount }, (_, i) =>
      toDoubaoFigTag(i + 1)
    ).join(" ");
    text = `参考图：${map}（按附件顺序一一对应）。\n${text}`;
  }

  const lockLines = Array.from({ length: attachedCount }, (_, i) => {
    const idx = i + 1;
    const info = legendBySlot.get(idx);
    const who = info ? `「${info.name}」` : "";
    const kindHint =
      info?.kind === "character"
        ? "人物五官/脸型/发型/年龄感/体型/服饰"
        : info?.kind === "scene"
          ? "空间布局/装修/陈设"
          : info?.kind === "prop"
            ? "道具形制/材质/颜色"
            : "外观";
    return `- ${toDoubaoFigTag(idx)}${who ? `=${who}` : ""}：只锁定${kindHint}；禁止把该图外貌套到其他姓名的角色上。`;
  }).join("\n");

  const characters = [...legendBySlot.entries()]
    .filter(([, info]) => info.kind === "character")
    .map(([slot, info]) => ({ slot, name: info.name }));

  let antiSwap = "";
  if (actors.length >= 1) {
    antiSwap += `\n【画面主体】站姿/动作的主角是「${actors[0].name}」，其脸必须来自 ${toDoubaoFigTag(actors[0].slot)}（附件第1优先脸），禁止长成其他参考图的脸。`;
  }
  if (characters.length >= 2) {
    antiSwap +=
      "\n【身份禁止互换·最重要】\n" +
      characters
        .map(
          (c) =>
            `- 「${c.name}」只能用 ${toDoubaoFigTag(c.slot)} 的脸/发型/服饰，禁止使用其他角色参考图。`
        )
        .join("\n") +
      "\n- 两个角色必须明显是不同的人（年龄/脸型/发型不同），绝对禁止融脸、双胞胎脸、同一张脸复制两人。";
  }
  if (locationOnly.length) {
    antiSwap +=
      "\n【未入画/工位角色】\n" +
      locationOnly
        .map((c) => {
          const tag = c.slot ? toDoubaoFigTag(c.slot) : "其参考图";
          return (
            `- 「${c.name}」在提示词里主要是地点（工位）。` +
            `优先：工位可空着，不要凭空再画一个长得像主角的人。` +
            `若画面出现坐在该工位的人，则此人必须是「${c.name}」，外貌只能来自 ${tag}，严禁画成「${actors[0]?.name || "其他角色"}」。`
          );
        })
        .join("\n");
  }

  const warn =
    seen.length > n
      ? `\n注意：提示词引用了 ${seen.length} 个 @图（${seen.join(",")}），但实际只收到 ${n} 张参考图。分镜请勾选全部「关联资产」。`
      : "";

  const orderHint = uploadOrder.some((v, i) => v !== i)
    ? `\n（已重排附件：画面主角参考图置于 ${toDoubaoFigTag(1)}，减轻第一张脸吞噬。）`
    : "";
  const dropHint = droppedUploadIdx.length
    ? `\n（已省略仅地点角色的参考脸 ${droppedUploadIdx.length} 张，避免被画成入画人物。）`
    : "";

  const faceHint =
    opts.requireFace !== false
      ? "\n重要：角色设定图若是多宫格，只取其中同一人的正脸/3/4侧脸特征，不要把宫格里多人脸混用。"
      : "";

  const header = `【多参考图角色一致性·强制】\n附件共 ${attachedCount} 张，按顺序对应 ${toDoubaoFigTag(1)}…${toDoubaoFigTag(attachedCount)}。${orderHint}${dropHint}\n${lockLines}${antiSwap}${warn}${faceHint}\n---\n`;
  if (!text.includes("【多参考图角色一致性")) {
    text = header + text;
  }

  if (opts.returnMeta) {
    const names = Array.from({ length: attachedCount }, (_, i) => {
      const info = legendBySlot.get(i + 1);
      return info ? `${info.name}.png` : null;
    });
    return {
      text,
      names,
      legendBySlot,
      characters,
      uploadOrder,
      locationOnly,
      actors,
      droppedUploadIdx,
    };
  }
  return text;
}
