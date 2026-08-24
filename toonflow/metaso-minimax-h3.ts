/**
 * Toonflow AI供应商模板
 * @version 2.0
 * 秘塔 metaso MiniMax-H3 v2
 * POST {base}/v2/video_generation
 * GET  {base}/v2/query/video_generation/{taskId}
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
  /** 运行时可能是单个 mode 字符串，也可能是数组 */
  mode: VideoMode | VideoMode[];
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

const vendor: VendorConfig = {
  id: "metasoh3",
  version: "1.2",
  author: "local",
  name: "秘塔 MiniMax-H3",
  description:
    "metaso 中转 MiniMax-H3 v2。支持文生视频、图生视频（首帧/首尾帧）、多模态参考。测试请选 **768P**、**9:16**、**5秒**。\n\n请求地址填 `https://metaso.cn/api/minimax`，不要填到 `/v2/video_generation`。",
  inputs: [
    { key: "apiKey", label: "API密钥", type: "password", required: true },
    {
      key: "baseUrl",
      label: "请求地址",
      type: "url",
      required: true,
      placeholder: "示例：https://metaso.cn/api/minimax",
    },
  ],
  inputValues: { apiKey: "", baseUrl: "https://metaso.cn/api/minimax" },
  models: [
    {
      name: "MiniMax-H3",
      modelName: "MiniMax-H3",
      type: "video",
      audio: true,
      associationSkills: "原生对白与音效。文生视频使用项目比例；带参考图/视频时接口 ratio 为 adaptive。",
      mode: [
        "text",
        "singleImage",
        "startEndRequired",
        "endFrameOptional",
        "startFrameOptional",
        ["imageReference:9", "videoReference:3", "audioReference:3"],
      ],
      durationResolutionMap: [
        {
          duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
          resolution: ["768P", "2K"],
        },
      ],
    },
  ],
};

// ============================================================
// 辅助工具
// ============================================================

const getHeaders = (): Record<string, string> => {
  const apiKey = vendor.inputValues.apiKey.replace(/^Bearer\s+/i, "").trim();
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
};

const getApiRoot = (): string => {
  return vendor.inputValues.baseUrl
    .trim()
    .replace(/\/$/, "")
    .replace(/\/v2\/video_generation$/i, "")
    .replace(/\/v2$/i, "");
};

const toDataUrl = (ref: ReferenceList): string => {
  if (ref.base64.startsWith("data:")) return ref.base64;
  if (ref.type === "image") return `data:image/png;base64,${ref.base64}`;
  if (ref.type === "video") return `data:video/mp4;base64,${ref.base64}`;
  return `data:audio/mp3;base64,${ref.base64}`;
};

const pickVideoUrlFromQuery = (data: any): string => {
  const task = data?.task || data;
  const candidates = [
    task?.content?.url,
    data?.content?.url,
    data?.file?.download_url,
    task?.file?.download_url,
    data?.download_url,
    data?.video_url,
    data?.url,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && /^https?:\/\//i.test(c.trim())) return c.trim();
  }
  return "";
};

const pickFileIdFromQuery = (data: any): string => {
  const id =
    data?.file_id ||
    data?.task?.file_id ||
    data?.file?.file_id ||
    data?.task?.content?.file_id;
  return id != null && String(id).trim() ? String(id).trim() : "";
};

const resolveDownloadUrl = async (root: string, data: any): Promise<string> => {
  const direct = pickVideoUrlFromQuery(data);
  if (direct) return direct;

  const fileId = pickFileIdFromQuery(data);
  if (!fileId) return "";

  // v1 兼容：Success 时只有 file_id，需再取 download_url
  const retrieveUrl = `${root}/v1/files/retrieve`;
  logger(`用 file_id 换下载地址: ${fileId}`);
  const resp = await axios.get(retrieveUrl, {
    headers: getHeaders(),
    params: { file_id: fileId },
    timeout: 60000,
  });
  const body = resp.data || {};
  const url =
    body?.file?.download_url ||
    body?.download_url ||
    body?.data?.download_url ||
    "";
  return typeof url === "string" ? url.trim() : "";
};

/** 自行下载并强制 video/mp4，避免 Toonflow 的 urlToBase64 按图片头处理导致无法播放 */
const bytesToBase64 = (bytes: Uint8Array): string => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const triple = (a << 16) | (b << 8) | c;
    out += chars[(triple >> 18) & 63] + chars[(triple >> 12) & 63];
    out += i + 1 < bytes.length ? chars[(triple >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? chars[triple & 63] : "=";
  }
  return out;
};

const downloadVideoAsDataUrl = async (videoUrl: string): Promise<string> => {
  if (videoUrl.startsWith("data:video")) return videoUrl;
  if (videoUrl.startsWith("data:")) {
    const raw = videoUrl.replace(/^data:[^;]+;base64,/, "");
    return `data:video/mp4;base64,${raw}`;
  }

  logger(`下载视频: ${videoUrl.slice(0, 120)}...`);
  let resp: any;
  try {
    resp = await axios.get(videoUrl, {
      responseType: "arraybuffer",
      timeout: 300000,
      headers: {
        ...getHeaders(),
        Accept: "*/*",
        Referer: "https://metaso.cn/",
      },
      validateStatus: (s: number) => s >= 200 && s < 400,
    });
  } catch (err: any) {
    logger(`带鉴权下载失败，尝试裸下: ${err?.message || err}`);
    resp = await axios.get(videoUrl, {
      responseType: "arraybuffer",
      timeout: 300000,
      headers: { Accept: "*/*", Referer: "https://www.minimaxi.com/" },
    });
  }

  const bytes = new Uint8Array(resp.data);
  if (bytes.length < 1024) {
    throw new Error(`视频文件过小（${bytes.length} bytes），下载可能失败`);
  }

  const head = Array.from(bytes.slice(0, 12))
    .map((n) => (n >= 32 && n < 127 ? String.fromCharCode(n) : "."))
    .join("");
  if (!/ftyp|moov|mdat/i.test(head)) {
    logger(`警告：下载内容可能不是标准 MP4（head=${head}）`);
  }

  logger(`视频下载完成，大小 ${(bytes.length / 1024 / 1024).toFixed(2)} MB，开始编码`);
  return `data:video/mp4;base64,${bytesToBase64(bytes)}`;
};

// ============================================================
// 适配器函数
// ============================================================

const textRequest = (model: TextModel) => {
  if (!vendor.inputValues.apiKey) throw new Error("缺少API Key");
  const apiKey = vendor.inputValues.apiKey.replace(/^Bearer\s+/i, "").trim();
  return createOpenAI({ baseURL: `${getApiRoot()}/v1`, apiKey }).chat(model.modelName);
};

const imageRequest = async (config: ImageConfig, model: ImageModel): Promise<string> => {
  return "";
};

const videoRequest = async (config: VideoConfig, model: VideoModel): Promise<string> => {
  if (!vendor.inputValues.apiKey) throw new Error("缺少API Key");
  if (!vendor.inputValues.baseUrl) throw new Error("缺少请求地址");

  const duration = Math.round(Number(config.duration));
  if (duration < 4 || duration > 15) throw new Error("MiniMax-H3 时长只能是 4–15 的整数");

  const resolution = String(config.resolution || "768P").toUpperCase();
  if (resolution !== "768P" && resolution !== "2K") throw new Error("MiniMax-H3 分辨率只能是 768P 或 2K");

  const refs = config.referenceList || [];
  const images = refs.filter((item) => item.type === "image");
  const videos = refs.filter((item) => item.type === "video");
  const audios = refs.filter((item) => item.type === "audio");
  const compressedImages: string[] = [];
  for (const img of images) {
    compressedImages.push(await zipImage(toDataUrl(img), 20 * 1024));
  }

  // Toonflow 运行时 mode 可能是 string 或 string[]，统一成数组
  const modes: any[] = Array.isArray(config.mode)
    ? config.mode
    : config.mode != null
      ? [config.mode]
      : ["text"];

  const content: any[] = [{ type: "text", text: config.prompt || "" }];
  const useStartEnd = modes.includes("startEndRequired");
  const useSingle = modes.includes("singleImage") || modes.includes("startFrameOptional");
  const useEndOnly = modes.includes("endFrameOptional") && !useStartEnd && !useSingle;
  const useOmni =
    videos.length > 0 ||
    audios.length > 0 ||
    modes.some((item) => Array.isArray(item) || String(item).includes("Reference"));
  let ratio: string = config.aspectRatio || "9:16";

  if (useStartEnd) {
    if (compressedImages.length < 2) throw new Error("首尾帧模式需要两张图片");
    content.push({ type: "image_url", image_url: { url: compressedImages[0] }, role: "first_frame" });
    content.push({ type: "image_url", image_url: { url: compressedImages[1] }, role: "last_frame" });
    ratio = "adaptive";
  } else if (useEndOnly) {
    if (!compressedImages.length) throw new Error("尾帧模式需要至少一张图片");
    content.push({ type: "image_url", image_url: { url: compressedImages[0] }, role: "last_frame" });
    ratio = "adaptive";
  } else if (useOmni) {
    if (!compressedImages.length && !videos.length && !audios.length) {
      throw new Error("多模态参考至少需要一张图、一段视频或一段音频");
    }
    for (const url of compressedImages.slice(0, 9)) {
      content.push({ type: "image_url", image_url: { url }, role: "reference_image" });
    }
    for (const vid of videos.slice(0, 3)) {
      content.push({ type: "video_url", video_url: { url: toDataUrl(vid) }, role: "reference_video" });
    }
    for (const aud of audios.slice(0, 3)) {
      content.push({ type: "audio_url", audio_url: { url: toDataUrl(aud) }, role: "reference_audio" });
    }
    ratio = "adaptive";
  } else if (useSingle) {
    if (!compressedImages.length) throw new Error("图生视频需要一张首帧图片");
    content.push({ type: "image_url", image_url: { url: compressedImages[0] }, role: "first_frame" });
    ratio = "adaptive";
  } else if (!ratio || ratio === "adaptive") {
    ratio = "9:16";
  }

  const reqBody = {
    model: model.modelName || "MiniMax-H3",
    content,
    resolution,
    duration,
    ratio,
  };

  const root = getApiRoot();
  const createUrl = `${root}/v2/video_generation`;
  logger(`开始提交 MiniMax-H3 任务：${createUrl}，ratio=${ratio}，${resolution}，${duration}s`);

  const submitResp = await axios.post(createUrl, reqBody, { headers: getHeaders() });
  const submitData = submitResp.data || {};
  const taskId = submitData.task_id || submitData.taskId || submitData.task?.id || submitData.id;
  if (!taskId) {
    const msg =
      submitData.task?.error?.message ||
      submitData.error?.message ||
      submitData.error ||
      submitData.base_resp?.status_msg ||
      JSON.stringify(submitData).slice(0, 400);
    throw new Error(`任务提交失败：${msg}`);
  }
  logger(`任务ID: ${taskId}`);

  const result = await pollTask(
    async () => {
      const queryResp = await axios.get(`${root}/v2/query/video_generation/${taskId}`, {
        headers: getHeaders(),
        timeout: 60000,
      });
      const data = queryResp.data || {};
      const status = String(
        data.task?.status || data.status || data.task_status || ""
      ).toLowerCase();
      const errMsg =
        data.task?.error?.message ||
        data.task?.error ||
        data.error?.message ||
        data.error ||
        data.base_resp?.status_msg;

      if (["succeeded", "success", "completed"].includes(status)) {
        try {
          const videoUrl = await resolveDownloadUrl(root, data);
          if (!videoUrl) {
            logger(`成功但无 URL，原始响应: ${JSON.stringify(data).slice(0, 600)}`);
            return { completed: true, error: "任务成功但没有视频地址（无 content.url / file_id）" };
          }
          return { completed: true, data: videoUrl };
        } catch (e: any) {
          return { completed: true, error: `取下载地址失败：${e?.message || e}` };
        }
      }
      if (["failed", "fail", "cancelled", "canceled", "error"].includes(status)) {
        return { completed: true, error: String(errMsg || `视频生成失败：${status}`) };
      }
      logger(`轮询中... ${status || "processing"}`);
      return { completed: false };
    },
    10000,
    900000
  );

  if (result.error) throw new Error(result.error);
  if (!result.data) throw new Error("视频生成成功但未返回地址");

  // 立刻下载成 data:video/mp4（CDN 链接会过期；也不要用可能按图片处理的 urlToBase64）
  return await downloadVideoAsDataUrl(result.data);
};

const ttsRequest = async (config: TTSConfig, model: TTSModel): Promise<string> => {
  return "";
};

const checkForUpdates = async (): Promise<{ hasUpdate: boolean; latestVersion: string; notice: string }> => {
  return {
    hasUpdate: false,
    latestVersion: "1.2",
    notice:
      "## 1.2\n- 成功后自行下载并返回 `data:video/mp4;base64`，修复 Toonflow 预览转圈/打不开\n- 兼容 file_id 换链与 content.url\n- 修复 mode 为字符串时 .some 报错",
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
