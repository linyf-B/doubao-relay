/**
 * Toonflow AI供应商模板
 * @version 2.0
 * 腾讯云 TokenHub 混元生图
 * Lite：POST {origin}/v1/api/image/lite  model=hy-image-lite
 * V3：  POST {origin}/v1/wand/hunyuan-image/v3-generation  model=hy-image-v3
 * 鉴权：Authorization: Bearer <TokenHub API Key>
 */

// ============================================================
// 类型定义
// ============================================================

type VideoMode =
  | "singleImage" //单图参考
  | "startEndRequired" //首尾帧（两张都得有）
  | "endFrameOptional" //首尾帧（尾帧可选）
  | "startFrameOptional" //首尾帧（首帧可选）
  | "text" //文本
  | (`videoReference:${number}` | `imageReference:${number}` | `audioReference:${number}`)[]; //多参考（数字代表限制数量）

interface TextModel {
  name: string;
  modelName: string;
  type: "text";
  think: boolean;
}

interface ImageModel {
  name: string;
  modelName: string;
  type: "image";
  mode: ("text" | "singleImage" | "multiReference")[];
  associationSkills?: string;
}

interface VideoModel {
  name: string;
  modelName: string;
  type: "video";
  mode: VideoMode[];
  associationSkills?: string;
  audio: "optional" | false | true;
  durationResolutionMap: { duration: number[]; resolution: string[] }[];
}

interface TTSModel {
  name: string;
  modelName: string;
  type: "tts";
  voices: { title: string; voice: string }[];
}

interface VendorConfig {
  id: string; //唯一ID，作为文件名存储用户磁盘上，禁止符号
  version: string; //版本号，格式为x.y，需遵守语义化版本控制
  name: string; //供应商名称
  author: string; //作者
  description?: string; //描述，支持Markdown格式
  icon?: string; //图标，仅支持Base64格式，建议尺寸为128x128像素
  inputs: { key: string; label: string; type: "text" | "password" | "url"; required: boolean; placeholder?: string }[];
  inputValues: Record<string, string>;
  models: (TextModel | ImageModel | VideoModel | TTSModel)[];
}

type ReferenceList =
  | { type: "image"; sourceType: "base64"; base64: string }
  | { type: "audio"; sourceType: "base64"; base64: string }
  | { type: "video"; sourceType: "base64"; base64: string };

interface ImageConfig {
  prompt: string;
  referenceList?: Extract<ReferenceList, { type: "image" }>[];
  size: "1K" | "2K" | "4K";
  aspectRatio: `${number}:${number}`;
}

interface VideoConfig {
  duration: number;
  resolution: string;
  aspectRatio: "16:9" | "9:16";
  prompt: string;
  referenceList?: ReferenceList[];
  audio?: boolean;
  mode: VideoMode[];
}

interface TTSConfig {
  text: string;
  voice: string;
  speechRate: number;
  pitchRate: number;
  volume: number;
  referenceList?: Extract<ReferenceList, { type: "audio" }>[];
}

interface PollResult {
  completed: boolean;
  data?: string;
  error?: string;
}

// ============================================================
// 全局声明
// ============================================================

declare const axios: any; // HTTP请求库
declare const logger: (msg: string) => void; // 日志函数
declare const jsonwebtoken: any; // JWT处理库
declare const zipImage: (base64: string, size: number) => Promise<string>; // 图片压缩函数，返回有头base64字符串
declare const zipImageResolution: (base64: string, w: number, h: number) => Promise<string>; // 图片分辨率调整函数，返回有头base64字符串
declare const mergeImages: (base64Arr: string[], maxSize?: string) => Promise<string>; // 图片合成函数，返回有头base64字符串
declare const urlToBase64: (url: string) => Promise<string>; // URL转Base64函数，返回有头base64字符串
declare const pollTask: (fn: () => Promise<PollResult>, interval?: number, timeout?: number) => Promise<PollResult>; // 轮询函数，fn为异步函数，interval为轮询间隔，timeout为超时时间，返回fn的结果
declare const createOpenAI: any;
declare const createDeepSeek: any;
declare const createZhipu: any;
declare const createQwen: any;
declare const createAnthropic: any;
declare const createOpenAICompatible: any;
declare const createXai: any;
declare const createMinimax: any;
declare const createGoogleGenerativeAI: any;
declare const exports: {
  vendor: VendorConfig;
  textRequest: (m: TextModel) => any; //文本模型
  imageRequest: (c: ImageConfig, m: ImageModel) => Promise<string>; //图片模型，返回有头base64字符串
  videoRequest: (c: VideoConfig, m: VideoModel) => Promise<string>; //视频模型，返回有头base64字符串
  ttsRequest: (c: TTSConfig, m: TTSModel) => Promise<string>; //（暂未开放）语音模型，返回有头base64字符串
  checkForUpdates?: () => Promise<{ hasUpdate: boolean; latestVersion: string; notice: string }>; //检查更新函数，返回是否有更新和最新版本号和更公告（支持Markdown格式）
  updateVendor?: () => Promise<string>; //更新函数，返回最新的代码文本
};

// ============================================================
// 供应商配置
// ============================================================

const SKILL =
  "竖屏9:16角色四视图与分镜静帧。写实古风五官，不要日漫大眼、Q版萌娃、网红脸、英文字幕。";

const vendor: VendorConfig = {
  id: "tencenttokenhub",
  version: "1.0",
  author: "local",
  name: "腾讯云 TokenHub 混元生图",
  description:
    "腾讯云 TokenHub 混元出图。请求地址只填域名：`https://tokenhub.tencentmaas.com`（新加坡用 `https://tokenhub-intl.tencentmaas.com`）。\n\n- **HY-Image-Lite** → `/v1/api/image/lite`，快，只文生图。竖屏 9:16 → `720:1280`。\n- **HY-Image-V3** → `/v1/wand/hunyuan-image/v3-generation`，语义更好，可参考图（最多 3 张）。竖屏 9:16 → `720x1280`。V3 面积上限约 1K，选 2K/4K 也会落在这档。\n\nAPI Key 只填界面，不要写进代码。鉴权是 `Authorization: Bearer sk-...`。",
  inputs: [
    { key: "apiKey", label: "API密钥", type: "password", required: true, placeholder: "TokenHub 控制台的 sk-..." },
    {
      key: "baseUrl",
      label: "请求地址",
      type: "url",
      required: true,
      placeholder: "示例：https://tokenhub.tencentmaas.com",
    },
  ],
  inputValues: {
    apiKey: "",
    baseUrl: "https://tokenhub.tencentmaas.com",
  },
  models: [
    {
      name: "HY-Image-Lite",
      modelName: "hy-image-lite",
      type: "image",
      mode: ["text"],
      associationSkills: SKILL,
    },
    {
      name: "HY-Image-V3",
      modelName: "hy-image-v3",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
      associationSkills: SKILL,
    },
  ],
};

// ============================================================
// 辅助工具
// ============================================================

const DEFAULT_NEGATIVE =
  "日漫大眼，Q版萌娃，网红脸，可爱妆，现代建筑，英文字幕，水印，照片滤镜，真人实拍，成人化儿童";

const getOrigin = (raw: string): string => {
  const m = String(raw || "")
    .trim()
    .match(/^(https?):\/\/([^/?#]+)/i);
  if (!m) throw new Error(`请求地址无效：${raw}`);
  return `${m[1]}://${m[2]}`;
};

const parseRatio = (aspectRatio: string): number => {
  const [aw, ah] = String(aspectRatio || "9:16")
    .split(":")
    .map((n) => Number(n) || 0);
  return aw > 0 && ah > 0 ? aw / ah : 9 / 16;
};

const close = (a: number, b: number) => Math.abs(a - b) < 0.08;

/** Lite：腾讯云 TextToImageLite 的 Resolution，格式 宽:高 */
const mapLiteResolution = (size: string, aspectRatio: string): string => {
  const r = parseRatio(aspectRatio);
  const long = size === "4K" ? 3840 : size === "2K" ? 1920 : 1280;
  if (close(r, 9 / 16)) {
    if (size === "4K") return "2160:3840";
    if (size === "2K") return "1080:1920";
    return "720:1280";
  }
  if (close(r, 16 / 9)) {
    if (size === "4K") return "3840:2160";
    if (size === "2K") return "1920:1080";
    return "1280:720";
  }
  if (close(r, 3 / 4)) return size === "1K" ? "768:1024" : `${Math.round(long * 0.75)}:${long}`;
  if (close(r, 4 / 3)) return size === "1K" ? "1024:768" : `${long}:${Math.round(long * 0.75)}`;
  return `${long}:${long}`;
};

/** V3：官方 size 为 宽x高，面积 ≤ 1024×1024，9:16 用预设 720x1280 */
const mapV3Size = (aspectRatio: string): string => {
  const r = parseRatio(aspectRatio);
  if (close(r, 9 / 16)) return "720x1280";
  if (close(r, 16 / 9)) return "1280x720";
  if (close(r, 3 / 4)) return "768x1024";
  if (close(r, 4 / 3)) return "1024x768";
  if (close(r, 3 / 5)) return "768x1280";
  if (close(r, 5 / 3)) return "1280x768";
  return "1024x1024";
};

const withPortraitHint = (prompt: string, aspectRatio: string): string => {
  const text = String(prompt || "").trim();
  if (!text) return text;
  if (close(parseRatio(aspectRatio), 9 / 16) && !/竖屏|9\s*[:：]\s*16/.test(text)) {
    return `竖屏9:16，${text}`;
  }
  return text;
};

const stripDataPrefix = (s: string): string =>
  String(s || "").replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/i, "");

const toDataImage = (content: string): string => {
  const trimmed = String(content || "").trim();
  if (!trimmed) throw new Error("接口没有返回图片");
  if (trimmed.startsWith("data:image/")) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return "";
  return `data:image/png;base64,${stripDataPrefix(trimmed)}`;
};

const pickImagePayload = (data: any): string => {
  if (!data || typeof data !== "object") return "";
  const nested = data.Response || data.response || data.result || data;
  const first = nested.data?.[0] || nested.images?.[0] || nested.output?.[0];
  const candidates = [
    first?.url,
    first?.b64_json,
    first?.base64,
    nested.result_image,
    nested.ResultImage,
    nested.url,
    typeof nested.images?.[0] === "string" ? nested.images[0] : nested.images?.[0]?.url,
    nested.image,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return "";
};

const axiosErrorText = (err: any): string => {
  const data = err?.response?.data;
  const status = err?.response?.status;
  let body = "";
  if (typeof data === "string") body = data;
  else if (data)
    body =
      data.error?.message ||
      data.message ||
      data.msg ||
      data.Response?.Error?.Message ||
      JSON.stringify(data).slice(0, 400);
  const prefix = status ? `HTTP ${status} ` : "";
  return `${prefix}${body || err?.message || err}`.trim();
};

const toImageResult = async (payload: string): Promise<string> => {
  if (/^https?:\/\//i.test(payload)) {
    logger("接口返回图片 URL，开始转 Base64");
    return await urlToBase64(payload);
  }
  return toDataImage(payload);
};

const refsToImages = async (refs: Extract<ReferenceList, { type: "image" }>[] | undefined): Promise<string[]> => {
  const list = (refs || []).slice(0, 3);
  const out: string[] = [];
  for (const ref of list) {
    let b64 = String(ref.base64 || "").trim();
    if (!b64) continue;
    const rawLen = stripDataPrefix(b64).length;
    if (rawLen > 10 * 1024 * 1024) {
      logger("参考图过大，先压缩");
      b64 = await zipImage(b64.startsWith("data:") ? b64 : `data:image/png;base64,${b64}`, 1024);
    }
    out.push(stripDataPrefix(b64));
  }
  return out;
};

// ============================================================
// 适配器函数
// ============================================================

const textRequest = (model: TextModel) => {
  throw new Error("腾讯云 TokenHub 这个供应商只出图。剧本/分镜请用讯飞 DeepSeek。");
};

const imageRequest = async (config: ImageConfig, model: ImageModel): Promise<string> => {
  const apiKey = (vendor.inputValues.apiKey || "").replace(/^Bearer\s+/i, "").trim();
  if (!apiKey) throw new Error("缺少 TokenHub API Key");
  if (!vendor.inputValues.baseUrl) throw new Error("缺少请求地址");

  const origin = getOrigin(vendor.inputValues.baseUrl);
  const name = String(model.modelName || "").toLowerCase();
  const isLite = name.indexOf("lite") >= 0;
  const prompt = withPortraitHint(String(config.prompt || "").trim(), config.aspectRatio);
  if (!prompt) throw new Error("缺少出图提示词");

  let url = "";
  let body: Record<string, any> = {};
  let timeout = 180000;

  if (isLite) {
    if (config.referenceList?.length) logger("HY-Image-Lite 只文生图，参考图已忽略");
    url = `${origin}/v1/api/image/lite`;
    body = {
      model: model.modelName || "hy-image-lite",
      prompt,
      negative_prompt: DEFAULT_NEGATIVE,
      resolution: mapLiteResolution(config.size, config.aspectRatio),
      rsp_img_type: "url",
      logo_add: 0,
    };
    timeout = 180000;
    logger(`TokenHub Lite：${url} ${body.resolution}`);
  } else {
    url = `${origin}/v1/wand/hunyuan-image/v3-generation`;
    const size = mapV3Size(config.aspectRatio);
    if (config.size === "2K" || config.size === "4K") {
      logger(`HY-Image-V3 面积上限约 1K，${config.size} 已落到 ${size}`);
    }
    body = {
      model: model.modelName || "hy-image-v3",
      prompt,
      size,
      revise: false,
    };
    const images = await refsToImages(config.referenceList);
    if (images.length) body.images = images;
    timeout = 300000;
    logger(`TokenHub V3：${url} ${size}${images.length ? ` 参考图${images.length}张` : ""}`);
  }

  let resp: any;
  try {
    resp = await axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      timeout,
    });
  } catch (err: any) {
    const msg = axiosErrorText(err);
    if (/401|invalid.?api.?key|unauthorized/i.test(msg)) {
      throw new Error("TokenHub 鉴权失败：检查 API Key，请求头必须是 Bearer sk-...，不要填讯飞 HMAC。");
    }
    if (/429/.test(msg)) throw new Error(`出图并发超限：${msg}`);
    if (/422/.test(msg)) throw new Error(`内容审核未通过：${msg}`);
    throw new Error(`出图请求失败：${msg}`);
  }

  const data = resp.data || {};
  const payload = pickImagePayload(data);
  if (!payload) throw new Error(`出图成功但没有图片：${JSON.stringify(data).slice(0, 400)}`);
  logger("出图成功");
  return await toImageResult(payload);
};

const videoRequest = async (config: VideoConfig, model: VideoModel): Promise<string> => {
  return "";
};

const ttsRequest = async (config: TTSConfig, model: TTSModel): Promise<string> => {
  return "";
};

const checkForUpdates = async (): Promise<{ hasUpdate: boolean; latestVersion: string; notice: string }> => {
  return {
    hasUpdate: false,
    latestVersion: "1.0",
    notice: "Lite 用 /v1/api/image/lite；V3 用 /v1/wand/hunyuan-image/v3-generation。密钥只填界面。",
  };
};

const updateVendor = async (): Promise<string> => {
  return "";
};

// ============================================================
// 导出
// ============================================================

exports.vendor = vendor;
exports.textRequest = textRequest;
exports.imageRequest = imageRequest;
exports.videoRequest = videoRequest;
exports.ttsRequest = ttsRequest;
exports.checkForUpdates = checkForUpdates;
exports.updateVendor = updateVendor;

// 这行代码用于确保当前文件被识别为模块，避免全局变量冲突
export {};
