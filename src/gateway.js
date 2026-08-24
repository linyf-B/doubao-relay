import express from "express";
import path from "node:path";
import { config } from "./config.js";
import {
  loadSession,
  saveSession,
  clearSession,
  getSessionStatus,
  maskSession,
  normalizeSessionId,
  listAccounts,
  setActiveAccount,
  removeAccount,
  upsertAccount,
  pickAvailableAccount,
  markAccountRateLimited,
  buildCookieHeader,
  sweepExpiredCooldowns,
  clearAccountCooldown,
  clearAllCooldowns,
} from "./session-store.js";
import { loginAndCaptureSession } from "./login-browser.js";
import { generateVideo } from "./video-client.js";
import { generateImage, RateLimitError } from "./image-client.js";
import {
  probeCdp,
  captureCdpScreenshot,
  isCdpConfigured,
} from "./cdp-preview.js";
import { isCdpEnabled } from "./cdp-samantha.js";
import { chromium } from "playwright";
import { logger, readLogTail } from "./logger.js";

let loginInFlight = null;

function extractBearer(req) {
  const h = req.headers.authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : "";
}

/** 从 OpenAI / Toonflow 请求体里抽出参考图（base64 或 URL） */
function collectRefImages(body = {}) {
  const out = [];
  const push = (v) => {
    if (!v) return;
    if (typeof v === "string" && v.trim()) {
      out.push(v.trim());
      return;
    }
    if (typeof v === "object") {
      const s =
        v.base64 ||
        v.url ||
        v.image_url?.url ||
        v.b64_json ||
        (typeof v.image === "string" ? v.image : "");
      if (s) {
        if (v.b64_json && !String(s).startsWith("data:")) {
          out.push(`data:image/png;base64,${s}`);
        } else {
          out.push(String(s));
        }
      }
    }
  };

  // 优先 images 数组；image 单字段仅在无数组时使用（避免与 images[0] 重复计入）
  if (Array.isArray(body.images) && body.images.length) {
    body.images.forEach(push);
  } else {
    push(body.image);
  }
  if (Array.isArray(body.reference_images)) body.reference_images.forEach(push);
  if (Array.isArray(body.referenceImages)) body.referenceImages.forEach(push);
  if (Array.isArray(body.referenceList)) body.referenceList.forEach(push);
  // OpenAI vision 风格
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (item?.image_url) push(item.image_url);
      if (item?.image) push(item.image);
    }
  }
  // 去重保序：不能只用前缀——JPEG data URL 常以相同 /9j/4AAQ... 开头，会把不同图误判成一张
  const seen = new Set();
  return out.filter((u) => {
    const k = `${u.length}:${u.slice(0, 48)}:${u.slice(-64)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function requireLocalKey(req, res, next) {
  const token = extractBearer(req);
  if (!token || token !== config.localApiKey) {
    return res.status(401).json({
      error: {
        message: "无效的 LOCAL_API_KEY。请使用 Authorization: Bearer <LOCAL_API_KEY>",
        type: "auth_error",
      },
    });
  }
  return next();
}

async function getUpstreamSessionId(req) {
  const bearer = extractBearer(req);
  if (bearer && bearer !== config.localApiKey && bearer.length > 20) {
    return normalizeSessionId(bearer);
  }
  const session = await loadSession();
  return session?.sessionId || null;
}

async function proxyJson(req, res, upstreamPath) {
  const sessionId = await getUpstreamSessionId(req);
  if (!sessionId) {
    return res.status(401).json({
      error: {
        message: "尚未登录豆包。请打开管理页点击「登录豆包」，或 POST /admin/login",
        type: "session_missing",
      },
    });
  }

  const url = `${config.upstreamUrl}${upstreamPath}`;
  let upstream;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sessionId}`,
      },
      body: JSON.stringify(req.body ?? {}),
    });
  } catch (err) {
    return res.status(502).json({
      error: {
        message: `无法连接上游 doubao-free-api（${config.upstreamUrl}）。请用 npm start 同时启动上游，或另开终端 npm run upstream`,
        detail: String(err.message || err),
        type: "upstream_unreachable",
      },
    });
  }

  const text = await upstream.text();
  const contentType = upstream.headers.get("content-type") || "application/json";
  res.status(upstream.status).type(contentType);

  if (contentType.includes("application/json")) {
    try {
      return res.send(JSON.parse(text));
    } catch {
      return res.send(text);
    }
  }
  return res.send(text);
}

/** 从调试浏览器同步 Cookie 到本地账号池（CDP 登录后用） */
async function syncCookiesFromCdp() {
  const cdpUrl = (process.env.DOUBAO_CDP_URL || "http://127.0.0.1:9222").replace(
    /\/$/,
    ""
  );
  logger.info("cdp sync cookies start", { cdpUrl });
  const browser = await chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0];
  if (!context) throw new Error("CDP 无浏览器上下文");
  const cookies = await context.cookies([
    "https://www.doubao.com",
    "https://doubao.com",
  ]);
  const session = cookies.find((c) => c.name === "sessionid" && c.value);
  if (!session?.value) {
    throw new Error("调试浏览器尚未登录豆包（未检测到 sessionid）");
  }
  const cookieHeader = buildCookieHeader(cookies);
  const saved = await upsertAccount(session.value, {
    source: "cdp",
    cookieHeader,
    label: `CDP ${new Date().toLocaleString()}`,
    setActive: true,
  });
  await clearAccountCooldown(saved.id).catch(() => {});
  logger.info("cdp sync cookies ok", {
    id: saved.id,
    masked: maskSession(saved.sessionId),
    cookieCount: cookies.length,
  });
  return saved;
}

async function runImageWithFailover(body) {
  const tried = [];
  let lastErr = null;
  const refImages = collectRefImages(body);

  // CDP 模式：优先用调试浏览器 Cookie，并忽略本地冷却
  if (isCdpEnabled()) {
    try {
      const synced = await syncCookiesFromCdp();
      logger.info("image via cdp", {
        prompt: String(body.prompt || "").slice(0, 80),
        model: body.model,
        ratio: body.ratio,
        refs: refImages.length,
      });
      const t0 = Date.now();
      const result = await generateImage({
        cookieHeader: synced.cookieHeader,
        prompt: body.prompt,
        model: body.model || "Seedream 4.5",
        ratio: body.ratio || "1:1",
        style: body.style || "默认",
        images: refImages,
        useCdp: true,
      });
      const uniq = [];
      const seenKey = new Set();
      for (const u of result.images) {
        const clean = String(u).replace(/\\u0026/g, "&");
        const k = clean.split("~")[0];
        if (seenKey.has(k)) continue;
        seenKey.add(k);
        uniq.push(clean);
      }
      result.images = uniq;
      logger.info("image ok (cdp)", {
        images: uniq.length,
        refs: refImages.length,
        ms: Date.now() - t0,
        account: maskSession(synced.sessionId),
      });
      return { result, account: synced };
    } catch (err) {
      lastErr = err;
      logger.warn("image cdp failed", { message: String(err.message || err) });
    }
  }

  const storeSnapshot = await listAccounts();
  // CDP 开启时强制清冷却再试
  if (isCdpEnabled()) {
    await clearAllCooldowns();
  }

  for (let i = 0; i < 8; i++) {
    const account = await pickAvailableAccount();
    if (!account) {
      const hasAny = storeSnapshot.length > 0 || tried.length > 0;
      throw Object.assign(
        new Error(
          lastErr?.message ||
            (hasAny
              ? `所有账号均限流/冷却中（已试 ${tried.length || storeSnapshot.length} 个）。CDP 模式下请保持调试浏览器登录；或点「清除全部冷却」。`
              : "尚未登录豆包。请先打开调试浏览器登录，或管理页登录。")
        ),
        {
          type: hasAny || lastErr ? "rate_limited" : "session_missing",
          needSwitchAccount: true,
          tried,
        }
      );
    }
    if (tried.includes(account.id)) {
      throw Object.assign(
        lastErr || new Error("可用账号已全部试过且仍失败。"),
        { type: "rate_limited", needSwitchAccount: true, tried }
      );
    }
    tried.push(account.id);

    const cookieHeader =
      account.cookieHeader ||
      buildCookieHeader(account.sessionId) ||
      `sessionid=${account.sessionId}; sessionid_ss=${account.sessionId}`;

    try {
      const result = await generateImage({
        cookieHeader,
        prompt: body.prompt,
        model: body.model || "Seedream 4.5",
        ratio: body.ratio || "1:1",
        style: body.style || "默认",
        images: refImages,
        useCdp: isCdpEnabled(),
      });
      const uniq = [];
      const seenKey = new Set();
      for (const u of result.images) {
        const clean = String(u).replace(/\\u0026/g, "&");
        const k = clean.split("~")[0];
        if (seenKey.has(k)) continue;
        seenKey.add(k);
        uniq.push(clean);
      }
      result.images = uniq;
      return { result, account };
    } catch (err) {
      lastErr = err;
      if (err instanceof RateLimitError || err?.type === "rate_limited") {
        // CDP 模式下不锁账号，避免误拦
        if (!isCdpEnabled()) {
          const sw = await markAccountRateLimited(account.id, err.message, 60 * 1000);
          if (sw.switched) continue;
        }
        continue;
      }
      throw err;
    }
  }

  throw Object.assign(lastErr || new Error("生图失败"), {
    type: lastErr?.type || "rate_limited",
    needSwitchAccount: true,
    tried,
  });
}

function startLogin(opts = {}) {
  if (loginInFlight) {
    return Promise.resolve({ ok: false, status: 409, message: "已有登录流程进行中" });
  }
  const logs = [];
  loginInFlight = loginAndCaptureSession({
    clearProfile: Boolean(opts.switchAccount),
    label: opts.label,
    onStatus: (msg) => logs.push(msg),
  })
    .then((saved) => ({
      ok: true,
      status: 200,
      id: saved.id,
      masked: maskSession(saved.sessionId),
      updatedAt: saved.updatedAt,
      logs,
    }))
    .catch((err) => ({
      ok: false,
      status: 500,
      message: String(err.message || err),
      logs,
    }))
    .finally(() => {
      loginInFlight = null;
    });
  return loginInFlight;
}

export function createApp() {
  const app = express();
  app.use(express.json({ limit: "80mb" }));

  app.use((req, res, next) => {
    if (req.path.startsWith("/admin/logs")) return next();
    if (req.path.startsWith("/admin/ref-preview")) return next();
    const quiet =
      req.path === "/admin/status" ||
      req.path === "/admin/accounts" ||
      req.path === "/admin/accounts/check" ||
      req.path === "/admin/cdp/status" ||
      req.path === "/admin/cdp/screenshot" ||
      req.path === "/health";
    const start = Date.now();
    res.on("finish", () => {
      if (quiet && res.statusCode < 400) return;
      logger.info("http", {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Date.now() - start,
      });
    });
    next();
  });

  app.use(express.static(path.join(config.root, "public")));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "doubao-relay" });
  });

  app.get("/admin/status", async (_req, res) => {
    const status = await getSessionStatus();
    let upstreamOk = false;
    try {
      const r = await fetch(`${config.upstreamUrl}/`, { method: "GET" });
      upstreamOk = r.status < 500;
    } catch {
      upstreamOk = false;
    }
    const cdp = await probeCdp();

    res.json({
      localApiKeyConfigured: Boolean(config.localApiKey),
      upstreamUrl: config.upstreamUrl,
      upstreamOk,
      cdp,
      cdpConfigured: isCdpConfigured(),
      session: {
        present: Boolean(status.sessionId),
        masked: status.masked,
        updatedAt: status.updatedAt,
        hasFullCookie: status.hasFullCookie,
        activeId: status.activeId,
      },
      accounts: status.accounts || [],
      accountCount: status.accountCount || 0,
      loginInProgress: Boolean(loginInFlight),
    });
  });

  app.get("/admin/cdp/status", async (_req, res) => {
    res.json(await probeCdp());
  });

  app.get("/admin/cdp/screenshot", async (_req, res) => {
    try {
      const shot = await captureCdpScreenshot();
      res.json(shot);
    } catch (err) {
      res.status(502).json({
        ok: false,
        message: String(err.message || err),
        tip: "请先用 Edge/Chrome 带 --remote-debugging-port=9222 启动并打开豆包",
      });
    }
  });

  app.get("/admin/logs", async (req, res) => {
    const lines = Math.min(Number(req.query.lines) || 200, 2000);
    const fromDisk = String(req.query.disk || "") === "1";
    if (fromDisk) {
      return res.json(await readLogTail(lines));
    }
    return res.json({
      ok: true,
      file: logger.filePath(),
      lines: logger.recent(lines),
    });
  });

  app.get("/admin/logs/stream", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const send = (entry) => {
      const payload =
        typeof entry === "string"
          ? { line: entry }
          : { line: entry.line, previews: entry.previews || undefined };
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    for (const entry of logger.recent(80)) send(entry);
    res.write(`event: meta\ndata: ${JSON.stringify({ file: logger.filePath() })}\n\n`);

    const off = logger.onLine(send);
    const heartbeat = setInterval(() => {
      res.write(`: ping ${Date.now()}\n\n`);
    }, 15000);

    req.on("close", () => {
      clearInterval(heartbeat);
      off();
    });
  });

  app.get("/admin/ref-preview/:name", (req, res) => {
    const name = String(req.params.name || "");
    if (!/^[a-zA-Z0-9._-]+\.(jpe?g|png|webp)$/i.test(name)) {
      return res.status(400).send("bad name");
    }
    const root = path.resolve(config.dataDir, "ref-previews");
    const file = path.resolve(root, name);
    if (!file.startsWith(root + path.sep) && file !== root) {
      return res.status(400).send("bad path");
    }
    return res.sendFile(file, (err) => {
      if (err) res.status(404).send("not found");
    });
  });

  app.get("/admin/accounts", async (_req, res) => {
    const sweep = await sweepExpiredCooldowns();
    res.json({
      accounts: await listAccounts(),
      checkedAt: sweep.checkedAt,
      clearedCooldowns: sweep.cleared,
    });
  });

  app.post("/admin/accounts/check", async (_req, res) => {
    const sweep = await sweepExpiredCooldowns();
    const status = await getSessionStatus();
    res.json({
      ok: true,
      ...status,
      clearedCooldowns: sweep.cleared,
      checkedAt: sweep.checkedAt,
    });
  });

  app.post("/admin/accounts/:id/clear-cooldown", async (req, res) => {
    try {
      const acc = await clearAccountCooldown(req.params.id);
      res.json({
        ok: true,
        id: acc.id,
        masked: maskSession(acc.sessionId),
        accounts: await listAccounts(),
      });
    } catch (err) {
      res.status(400).json({ ok: false, message: String(err.message || err) });
    }
  });

  app.post("/admin/accounts/active", async (req, res) => {
    try {
      const acc = await setActiveAccount(String(req.body?.id || ""));
      res.json({ ok: true, id: acc.id, masked: maskSession(acc.sessionId) });
    } catch (err) {
      res.status(400).json({ ok: false, message: String(err.message || err) });
    }
  });

  app.delete("/admin/accounts/:id", async (req, res) => {
    await removeAccount(req.params.id);
    res.json({ ok: true, accounts: await listAccounts() });
  });

  app.post("/admin/login", async (req, res) => {
    const switchAccount = Boolean(req.body?.switchAccount || req.query?.switch);
    const result = await startLogin({
      switchAccount,
      label: switchAccount ? `换号 ${new Date().toLocaleString()}` : undefined,
    });
    return res.status(result.status || (result.ok ? 200 : 500)).json(result);
  });

  app.post("/admin/session", async (req, res) => {
    const raw = String(req.body?.sessionId || req.body?.cookie || "").trim();
    if (!raw) {
      return res.status(400).json({ ok: false, message: "请粘贴 sessionid 或整段 Cookie" });
    }
    // 整段 Cookie：同时作为 cookieHeader 传入，避免只剩 sessionid
    const looksLikeCookieJar = /sessionid=/i.test(raw) && raw.includes(";");
    const saved = await upsertAccount(raw, {
      source: "manual",
      cookieHeader: req.body?.cookieHeader
        ? buildCookieHeader(req.body.cookieHeader)
        : looksLikeCookieJar
          ? buildCookieHeader(raw)
          : undefined,
      label: req.body?.label,
      setActive: true,
    });
    // 粘贴新 Cookie 后清掉所有本地冷却（网页能用说明不该被本地锁死）
    await clearAllCooldowns();
    res.json({
      ok: true,
      id: saved.id,
      masked: maskSession(saved.sessionId),
      updatedAt: saved.updatedAt,
      hasFullCookie: Boolean(saved.cookieHeader && saved.cookieHeader.includes(";")),
      cookieCount: (saved.cookieHeader || "").split(";").filter(Boolean).length,
      accounts: await listAccounts(),
    });
  });

  app.post("/admin/accounts/clear-cooldowns", async (_req, res) => {
    const result = await clearAllCooldowns();
    res.json({ ok: true, ...result, accounts: await listAccounts() });
  });

  app.delete("/admin/session", async (_req, res) => {
    await clearSession();
    res.json({ ok: true });
  });

  // 生图：本机直连豆包 + 限流自动换号
  app.post("/v1/images/generations", requireLocalKey, async (req, res) => {
    req.setTimeout?.(300_000);
    res.setTimeout?.(300_000);
    try {
      const body = req.body || {};
      if (!body.prompt) {
        return res.status(400).json({
          error: { message: "prompt 不能为空", type: "invalid_request" },
        });
      }
      logger.info("image request", {
        prompt: String(body.prompt).slice(0, 120),
        model: body.model,
        ratio: body.ratio,
        refs: collectRefImages(body).length,
        imagesIsArray: Array.isArray(body.images),
        imagesLen: Array.isArray(body.images) ? body.images.length : body.images == null ? null : 1,
        hasImageField: Boolean(body.image),
        bodyKeys: Object.keys(body),
        cdp: isCdpEnabled(),
      });
      const { result, account } = await runImageWithFailover(body);
      logger.info("image response", {
        images: result.images?.length || 0,
        account: maskSession(account.sessionId),
      });
      return res.json({
        created: Math.floor(Date.now() / 1000),
        id: account.id,
        model: result.model || body.model || "doubao",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: result.content || "",
              images: result.images,
            },
            finish_reason: "stop",
          },
        ],
        data: result.images.map((url) => ({ url })),
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        account: { id: account.id, masked: maskSession(account.sessionId) },
      });
    } catch (err) {
      const status = err.type === "session_missing" ? 401 : err.type === "rate_limited" ? 429 : 500;
      logger.error("image failed", {
        status,
        type: err.type,
        message: String(err.message || err),
      });
      return res.status(status).json({
        error: {
          message: String(err.message || err),
          type: err.type || "image_generation_failed",
          needSwitchAccount: Boolean(err.needSwitchAccount || err.type === "rate_limited"),
          tried: err.tried || [],
        },
      });
    }
  });

  app.post("/v1/chat/completions", requireLocalKey, (req, res) =>
    proxyJson(req, res, "/v1/chat/completions")
  );

  const handleVideoGeneration = async (req, res) => {
    req.setTimeout?.(600_000);
    res.setTimeout?.(600_000);
    try {
      const body = req.body || {};
      if (!body.prompt) {
        return res.status(400).json({
          error: { message: "prompt 不能为空", type: "invalid_request" },
        });
      }

      let cookieHeader = "";
      let sessionId = await getUpstreamSessionId(req);
      if (isCdpEnabled()) {
        try {
          const synced = await syncCookiesFromCdp();
          cookieHeader = synced.cookieHeader;
          sessionId = synced.sessionId;
        } catch (err) {
          logger.warn("video cdp sync failed", { message: String(err.message || err) });
        }
      }
      if (!cookieHeader && !sessionId) {
        return res.status(401).json({
          error: {
            message:
              "尚未登录豆包。请保持调试浏览器登录（DOUBAO_USE_CDP=1），或管理页登录。",
            type: "session_missing",
          },
        });
      }
      if (!cookieHeader && sessionId) {
        const store = await listAccounts();
        const acc =
          store.find((a) => a.sessionId === sessionId) ||
          store.find((a) => a.active);
        cookieHeader =
          acc?.cookieHeader ||
          `sessionid=${sessionId}; sessionid_ss=${sessionId}`;
      }

      logger.info("video request", {
        prompt: String(body.prompt).slice(0, 100),
        model: body.model,
        duration: body.duration ?? body.seconds,
        cdp: isCdpEnabled(),
      });

      const result = await generateVideo(sessionId, {
        cookieHeader,
        useCdp: isCdpEnabled(),
        prompt: body.prompt,
        model: body.model,
        duration: body.duration ?? body.seconds,
        ratio: body.ratio || body.aspect_ratio || body.aspectRatio,
        imageKeys: body.imageKeys || body.ref_image_keys || [],
      });
      const url = result.videos?.[0]?.video_url;
      logger.info("video response", {
        videos: result.videos?.length || 0,
        pending: Boolean(result.pending),
        taskId: result.provider_task_id,
      });
      return res.json({
        created: Math.floor(Date.now() / 1000),
        model: result.model,
        status: result.pending ? "processing" : "completed",
        pending: Boolean(result.pending),
        accepted: Boolean(result.accepted || result.pending),
        data: url ? [{ url, revised_prompt: body.prompt }] : [],
        videos: result.videos || [],
        message: result.message,
        estimated_wait_seconds: result.estimated_wait_seconds,
        provider_task_id: result.provider_task_id,
        conversation_id: result.conversation_id,
      });
    } catch (err) {
      const msg = String(err.message || err);
      // 风控/过载不当 pending
      if (
        /出了点问题|疑似包含侵权|违规内容|无法返回该内容|请稍后重试|服务过载/.test(
          msg
        )
      ) {
        logger.error("video failed", { message: msg.slice(0, 200) });
        return res.status(500).json({
          error: {
            message: msg,
            type: /侵权|违规/.test(msg)
              ? "content_policy_blocked"
              : "video_generation_failed",
          },
        });
      }
      // 兜底：纯受理文案不当失败
      if (
        /预计等待|预计等|视频生成好后|我会主动发送|消耗每日免费额度|本次使用.+生成|视频生成已提交/.test(
          msg
        )
      ) {
        logger.info("video accepted (catch pending)", { message: msg.slice(0, 160) });
        return res.json({
          created: Math.floor(Date.now() / 1000),
          model: req.body?.model || "Seedance",
          status: "processing",
          pending: true,
          accepted: true,
          data: [],
          videos: [],
          message: msg.replace(/^视频任务提交失败：/, ""),
          estimated_wait_seconds: 300,
        });
      }
      logger.error("video failed", { message: msg });
      return res.status(500).json({
        error: {
          message: msg,
          type: "video_generation_failed",
        },
      });
    }
  };

  app.post("/v1/videos/generations", requireLocalKey, handleVideoGeneration);
  app.post("/v1/videos", requireLocalKey, handleVideoGeneration);
  app.post("/v1/video/generations", requireLocalKey, handleVideoGeneration);

  app.post("/token/check", requireLocalKey, async (req, res) => {
    const session = await loadSession();
    const token = req.body?.token || session?.sessionId;
    if (!token) {
      return res.status(400).json({ live: false, error: "no session" });
    }
    try {
      const r = await fetch(`${config.upstreamUrl}/token/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await r.json();
      return res.status(r.status).json(data);
    } catch (err) {
      return res.status(502).json({ live: false, error: String(err.message || err) });
    }
  });

  return app;
}
