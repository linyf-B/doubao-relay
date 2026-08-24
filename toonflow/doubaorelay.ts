/**
 * Toonflow AI供应商 — 豆包本地中转（doubao-relay）
 * @version 1.0
 *
 * 对接本机 doubao-relay：
 *   - 网关默认 http://127.0.0.1:8787
 *   - Authorization: Bearer <LOCAL_API_KEY>（见 doubao/.env）
 *   - 需先 npm start，并在管理页登录豆包
 */

// ============================================================
// 类型定义
// ============================================================

type VideoMode =
  | "singleImage"
  | "startEndRequired"
  | "endFrameOptional"
  | "startFrameOptional"
  | "text"
  | (`videoReference:${number}` | `imageReference:${number}` | `audioReference:${number}`)[];

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
  id: string;
  version: string;
  name: string;
  author: string;
  description?: string;
  icon?: string;
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
  /** Toonflow ≥2.0 主字段 */
  referenceList?: Extract<ReferenceList, { type: "image" }>[];
  /** Toonflow <2.0 会把 referenceList 转成此字段；两路都要读，防止只收到 1 张 */
  imageBase64?: string[];
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

declare const axios: any;
declare const logger: (msg: string) => void;
declare const jsonwebtoken: any;
declare const zipImage: (base64: string, size: number) => Promise<string>;
declare const zipImageResolution: (base64: string, w: number, h: number) => Promise<string>;
declare const mergeImages: (base64Arr: string[], maxSize?: string) => Promise<string>;
declare const urlToBase64: (url: string) => Promise<string>;
declare const pollTask: (fn: () => Promise<PollResult>, interval?: number, timeout?: number) => Promise<PollResult>;
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
  textRequest: (m: TextModel) => any;
  imageRequest: (c: ImageConfig, m: ImageModel) => Promise<string>;
  videoRequest: (c: VideoConfig, m: VideoModel) => Promise<string>;
  ttsRequest: (c: TTSConfig, m: TTSModel) => Promise<string>;
  checkForUpdates?: () => Promise<{ hasUpdate: boolean; latestVersion: string; notice: string }>;
  updateVendor?: () => Promise<string>;
};

// ============================================================
// 供应商配置
// ============================================================

const vendor: VendorConfig = {
  id: "doubaorelay",
  version: "2.2",
  author: "local",
  name: "豆包本地中转",
  description:
    "## 豆包本地中转（doubao-relay）\n\n" +
    "对接本机 `doubao` 项目网关，免官方 ARK Key，使用网页版登录态。\n\n" +
    "**使用前请：**\n" +
    "1. 在 `doubao` 目录执行 `npm start`\n" +
    "2. 打开 http://127.0.0.1:8787 登录豆包\n" +
    "3. 将 `.env` 中的 `LOCAL_API_KEY` 填到下方 API 密钥\n\n" +
    "默认请求地址：`http://127.0.0.1:8787/v1`\n\n" +
    "**视频：** Seedance 2.5 / 2.0 / 2.0 Fast / 2.0 Mini；时长 4–15 秒；比例见「默认视频比例」。\n\n" +
    "> 仅限个人自用；非官方接口，可能因网页改版失效。",
  inputs: [
    {
      key: "apiKey",
      label: "本地 API 密钥",
      type: "password",
      required: true,
      placeholder: "与 doubao/.env 的 LOCAL_API_KEY 一致",
    },
    {
      key: "baseUrl",
      label: "请求地址",
      type: "url",
      required: true,
      placeholder: "http://127.0.0.1:8787/v1",
    },
    {
      key: "videoRatio",
      label: "默认视频比例",
      type: "text",
      required: false,
      placeholder: "自动 / 3:4 / 4:3 / 9:16 / 16:9 / 1:1 / 21:9（留空则用任务里的比例）",
    },
  ],
  inputValues: {
    apiKey: "local-dev-key-change-me",
    baseUrl: "http://127.0.0.1:8787/v1",
    videoRatio: "",
  },
  models: [
    { name: "豆包对话", modelName: "doubao", type: "text", think: false },
    {
      name: "Seedream 5.0 Lite",
      modelName: "Seedream 5.0 Lite",
      type: "image",
      // 不要同时声明 singleImage：Toonflow 会走单图路径，referenceList 只留 1 张
      mode: ["text", "multiReference"],
      associationSkills: "专业出图 · 多参考图角色锁定 · 约 4 倍消耗",
    },
    {
      name: "Seedream 5.0",
      modelName: "Seedream 5.0",
      type: "image",
      mode: ["text", "multiReference"],
      associationSkills: "进阶效果 · 多参考图角色锁定 · 约 3 倍消耗",
    },
    {
      name: "Seedream 4.5",
      modelName: "Seedream 4.5",
      type: "image",
      mode: ["text", "multiReference"],
      associationSkills: "日常生成 · 多参考图",
    },
    {
      name: "Seedream 4.0",
      modelName: "Seedream 4.0",
      type: "image",
      mode: ["text", "multiReference"],
      associationSkills: "基础生图 · 多参考图",
    },
    {
      name: "Seedance 2.5",
      modelName: "Seedance 2.5",
      type: "video",
      mode: ["text"],
      audio: "optional",
      associationSkills: "旗舰视频标杆 · 约 5 倍消耗；时长 4–15s；比例见供应商「默认视频比例」",
      durationResolutionMap: [
        {
          duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
          resolution: ["720P", "1080P"],
        },
      ],
    },
    {
      name: "Seedance 2.0",
      modelName: "Seedance 2.0",
      type: "video",
      mode: ["text"],
      audio: "optional",
      associationSkills: "进阶画面表现 · 约 2 倍消耗；时长 4–15s",
      durationResolutionMap: [
        {
          duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
          resolution: ["720P", "1080P"],
        },
      ],
    },
    {
      name: "Seedance 2.0 Fast",
      modelName: "Seedance 2.0 Fast",
      type: "video",
      mode: ["text"],
      audio: "optional",
      associationSkills: "快速出片选择；时长 4–15s",
      durationResolutionMap: [
        {
          duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
          resolution: ["720P", "480P"],
        },
      ],
    },
    {
      name: "Seedance 2.0 Mini",
      modelName: "Seedance 2.0 Mini",
      type: "video",
      mode: ["text"],
      audio: "optional",
      associationSkills: "日常生成使用；时长 4–15s",
      durationResolutionMap: [
        {
          duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
          resolution: ["720P", "480P"],
        },
      ],
    },
  ],
};

// ============================================================
// 辅助工具
// ============================================================

const getApiKey = () => {
  const raw = String(vendor.inputValues.apiKey || "").trim();
  if (!raw) throw new Error("缺少本地 API 密钥（LOCAL_API_KEY）");
  return raw.replace(/^Bearer\s+/i, "");
};

const getBaseUrl = () => {
  const raw = String(vendor.inputValues.baseUrl || "").trim().replace(/\/+$/, "");
  if (!raw) throw new Error("缺少请求地址 baseUrl");
  return raw;
};

const pickImageUrl = (data: any): string => {
  let payload: any = data;
  if (!payload) return "";
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      const m =
        payload.match(/https?:\/\/[^\s"'\\<>]+(?:byteimg|imagex|tos-cn)[^\s"'\\<>]*/i) ||
        payload.match(/https?:\/\/[^\s"'\\<>]+\.(?:png|jpe?g|webp)[^\s"'\\<>]*/i);
      return m ? m[0].replace(/\\u0026/g, "&") : "";
    }
  }

  if (Array.isArray(payload?.data)) {
    for (const item of payload.data) {
      if (item?.url) return String(item.url);
      if (item?.b64_json) return `data:image/png;base64,${item.b64_json}`;
    }
  }

  const nested = payload?.choices?.[0]?.message?.images;
  if (Array.isArray(nested)) {
    for (const item of nested) {
      if (typeof item === "string" && /^https?:\/\//.test(item)) return item;
      if (item?.url) return String(item.url);
      if (item?.image_ori?.url) return String(item.image_ori.url);
    }
  }

  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    const m =
      content.match(/https?:\/\/[^\s)"']+(?:byteimg|imagex|tos-cn)[^\s)"']*/i) ||
      content.match(/https?:\/\/[^\s)"']+\.(?:png|jpe?g|webp)[^\s)"']*/i);
    if (m) return m[0];
  }

  // 兜底：深度扫描任意图片 URL
  const found: string[] = [];
  const walk = (v: any, depth = 0) => {
    if (!v || depth > 8 || found.length) return;
    if (typeof v === "string") {
      if (/^https?:\/\//.test(v) && /(\.png|\.jpe?g|\.webp|byteimg|imagex|tos-cn)/i.test(v)) {
        found.push(v);
      }
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) walk(item, depth + 1);
      return;
    }
    if (typeof v === "object") {
      for (const item of Object.values(v)) walk(item, depth + 1);
    }
  };
  walk(payload);
  return found[0] || "";
};

const extractErrorMessage = (err: any): string => {
  const d = err?.response?.data;
  if (typeof d === "string" && d) return d;
  if (d?.error?.message) return String(d.error.message);
  if (d?.message) return String(d.message);
  if (err?.message) return String(err.message);
  return "未知错误";
};

// ============================================================
// 适配器函数
// ============================================================

const textRequest = (model: TextModel) => {
  const apiKey = getApiKey();
  const baseURL = getBaseUrl();
  logger(`豆包中转文本模型: ${model.modelName} @ ${baseURL}`);
  return createOpenAI({ baseURL, apiKey }).chat(model.modelName);
};

const imageRequest = async (config: ImageConfig, model: ImageModel): Promise<string> => {
  const apiKey = getApiKey();
  const baseUrl = getBaseUrl();
  const prompt = String(config.prompt || "").trim();
  if (!prompt) throw new Error("提示词不能为空");

  const ratio = String(config.aspectRatio || "1:1");
  const body: Record<string, any> = {
    model: model.modelName || "Seedream 4.0",
    prompt,
    ratio,
    style: "默认",
    stream: false,
  };

  // 同时吃 referenceList（≥2.0）与 imageBase64（<2.0 转换结果），取并集保序去重
  const fromList = (config.referenceList || []).map((r) => r?.base64).filter(Boolean) as string[];
  const fromLegacy = ((config as any).imageBase64 || []).filter(Boolean) as string[];
  const seenB64 = new Set<string>();
  const refs: string[] = [];
  for (const b of [...fromList, ...fromLegacy]) {
    // 禁止只用前缀：JPEG data URL 常以相同 /9j/4AAQ... 开头，会把场景/道具误判成重复丢掉
    const key = `${String(b).length}:${String(b).slice(0, 40)}:${String(b).slice(-80)}`;
    if (seenB64.has(key)) continue;
    seenB64.add(key);
    refs.push(b);
  }
  logger(
    `参考图入参: referenceList=${fromList.length}, imageBase64=${fromLegacy.length}, merged=${refs.length}`
  );

  const mentioned = Array.from(
    new Set(
      [
        ...Array.from(String(prompt).matchAll(/[@＠]?\s*\[\s*图片\s*(\d+)\s*\]/gi)),
        ...Array.from(String(prompt).matchAll(/[@＠]\s*图片\s*(\d+)/gi)),
        ...Array.from(String(prompt).matchAll(/[@＠]\s*图\s*(\d+)/gi)),
      ].map((m) => Number(m[1]))
    )
  ).filter((n) => n > 0);

  if (refs.length > 0) {
    // 多参考图：顺序必须与提示词 @图1/@图片1 一致；场景/道具图也要连进节点才会进 referenceList
    body.images = refs;
    body.image = body.images[0];
    // Toonflow zipImage 的 size 实际按「字节」比较（注释写 KB 是错的）；目标约 1.5MB，避免压成糊图导致多参考失效
    try {
      const zipped: string[] = [];
      const maxBytes = 1536 * 1024;
      for (const b64 of body.images) {
        const rawLen = String(b64).length;
        if (rawLen > maxBytes) {
          zipped.push(
            await zipImage(b64.startsWith("data:") ? b64 : `data:image/png;base64,${b64}`, maxBytes)
          );
        } else {
          zipped.push(b64);
        }
      }
      body.images = zipped;
      body.image = zipped[0];
    } catch (e: any) {
      logger(`参考图压缩跳过: ${e?.message || e}`);
    }
    logger(`图生图参考图已附加 ${body.images.length} 张（按顺序对应 @图1…）`);
    if (mentioned.length && Math.max(...mentioned) > body.images.length) {
      logger(
        `警告：提示词引用了 @图${Math.max(...mentioned)}，但实际只拿到 ${body.images.length} 张参考图字节。分镜请查「关联资产」；工作流请确认每条参考图连线有效（线上 X 是删除按钮不是断线）。`
      );
    }
  } else if (mentioned.length) {
    logger(
      `警告：提示词含 @图/@图片，但未收到任何参考图字节（共提到 ${mentioned.join(",")}）。`
    );
  }

  const url = `${baseUrl}/images/generations`;
  logger(`提交生图: model=${body.model}, ratio=${ratio}, size=${config.size}, refs=${body.images?.length || 0}`);

  let resp: any;
  try {
    resp = await axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: 300000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
  } catch (err: any) {
    const msg = extractErrorMessage(err);
    if (/rate\s*limited|限流|风控|needSwitchAccount|换账号/i.test(msg)) {
      throw new Error(`${msg}（请在中转管理页点「换账号登录」）`);
    }
    throw new Error(`豆包中转生图失败: ${msg}`);
  }

  const imageUrl = pickImageUrl(resp?.data);
  if (!imageUrl) {
    const preview = JSON.stringify(resp?.data ?? resp).slice(0, 800);
    logger(`生图响应无图片字段: ${preview}`);
    throw new Error(`生图成功但未解析到图片 URL。响应摘要: ${preview}`);
  }

  if (imageUrl.startsWith("data:image")) {
    logger("生图完成（已是 base64）");
    return imageUrl;
  }

  logger(`下载图片: ${imageUrl.slice(0, 120)}...`);
  return await urlToBase64(imageUrl);
};

const normalizeVideoRatio = (raw: string): string | undefined => {
  const v = String(raw || "").trim();
  if (!v) return undefined;
  if (/^(自动|auto|adaptive)$/i.test(v)) return undefined; // 不传 ratio = 豆包「自动」
  const allowed = ["3:4", "4:3", "9:16", "16:9", "1:1", "21:9"];
  if (allowed.includes(v)) return v;
  // 兼容 toonflow 仅有的 16:9 / 9:16
  if (v.includes("9:16")) return "9:16";
  if (v.includes("16:9")) return "16:9";
  return v;
};

const resolveVideoRatio = (config: VideoConfig): string | undefined => {
  const fromVendor = String(vendor.inputValues.videoRatio || "").trim();
  // 填了供应商「默认视频比例」则优先（可设 自动/3:4/1:1/21:9 等）
  if (fromVendor) return normalizeVideoRatio(fromVendor);
  // 否则用 Toonflow 任务里的 aspectRatio（通常为 16:9 / 9:16）
  return normalizeVideoRatio(String(config.aspectRatio || "16:9"));
};

const pickVideoUrl = (data: any): string => {
  if (!data) return "";
  if (Array.isArray(data?.data)) {
    for (const item of data.data) {
      if (item?.url) return String(item.url);
    }
  }
  if (Array.isArray(data?.videos) && data.videos[0]?.video_url) {
    return String(data.videos[0].video_url);
  }
  if (data?.video_url) return String(data.video_url);
  return "";
};

const videoRequest = async (config: VideoConfig, model: VideoModel): Promise<string> => {
  const apiKey = getApiKey();
  const baseUrl = getBaseUrl();
  const prompt = String(config.prompt || "").trim();
  if (!prompt) throw new Error("视频提示词不能为空");

  let duration = Number(config.duration || 10);
  if (!Number.isFinite(duration)) duration = 10;
  duration = Math.min(15, Math.max(4, Math.round(duration)));

  const ratio = resolveVideoRatio(config);
  const body: Record<string, any> = {
    model: model.modelName || "Seedance 2.0 Mini",
    prompt,
    duration,
    resolution: config.resolution || "720P",
  };
  if (ratio) body.ratio = ratio;

  if (config.referenceList && config.referenceList.length > 0) {
    logger("当前版本视频接口以文生视频为主，参考媒体暂未上传到豆包 TOS，已忽略 referenceList");
  }

  const url = `${baseUrl}/videos/generations`;
  logger(
    `提交生视频: model=${body.model}, duration=${duration}s, ratio=${ratio || "自动"}, resolution=${body.resolution}`
  );

  let resp: any;
  try {
    resp = await axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: 600000,
    });
  } catch (err: any) {
    throw new Error(`豆包中转生视频失败: ${extractErrorMessage(err)}`);
  }

  const videoUrl = pickVideoUrl(resp?.data);
  if (!videoUrl) {
    logger(`生视频响应无 URL: ${JSON.stringify(resp?.data).slice(0, 500)}`);
    throw new Error(resp?.data?.error?.message || resp?.data?.message || "未拿到视频地址");
  }

  logger(`下载视频: ${videoUrl.slice(0, 120)}...`);
  return await urlToBase64(videoUrl);
};

const ttsRequest = async (_config: TTSConfig, _model: TTSModel): Promise<string> => {
  throw new Error("当前豆包本地中转未接入 TTS");
};

const checkForUpdates = async (): Promise<{ hasUpdate: boolean; latestVersion: string; notice: string }> => {
  return {
    hasUpdate: false,
    latestVersion: "2.2",
    notice:
      "## 2.2\n修复 zipImage 压糊（size 按字节）：参考图保留约 1.5MB，避免多参考形同虚设。\n## 2.1\n修复 JPEG/PNG 公共文件头导致参考图误去重。",
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

export {};
