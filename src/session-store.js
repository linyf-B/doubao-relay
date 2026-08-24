import fs from "node:fs/promises";
import crypto from "node:crypto";
import { config } from "./config.js";

async function ensureDataDir() {
  await fs.mkdir(config.dataDir, { recursive: true });
}

/**
 * 从整段 Cookie / 粘贴文本中提取真正的 sessionid。
 */
export function normalizeSessionId(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  if (/^[a-f0-9]{16,64}$/i.test(text)) return text;
  const m =
    text.match(/(?:^|[;\s])sessionid=([^;\s]+)/i) ||
    text.match(/sessionid_ss=([^;\s]+)/i);
  if (m?.[1]) return decodeURIComponent(m[1].trim());
  const bearer = text.match(/^Bearer\s+(.+)$/i);
  if (bearer?.[1]) return normalizeSessionId(bearer[1]);
  return text;
}

/** 把 Cookie 数组或粘贴串整理成请求头 */
export function buildCookieHeader(input) {
  if (!input) return "";
  if (Array.isArray(input)) {
    return input
      .filter((c) => c?.name && c?.value != null)
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  }
  const text = String(input).trim();
  if (!text) return "";
  if (text.includes("=") && (text.includes(";") || /sessionid=/i.test(text))) {
    return text;
  }
  const sid = normalizeSessionId(text);
  return sid ? `sessionid=${sid}; sessionid_ss=${sid}` : "";
}

/** 是否具备较完整的浏览器 Cookie（避免仅 sessionid 被风控） */
export function hasRichCookieHeader(cookieHeader) {
  const h = String(cookieHeader || "");
  if (!h) return false;
  const names = new Set(
    h
      .split(";")
      .map((p) => p.trim().split("=")[0]?.toLowerCase())
      .filter(Boolean)
  );
  return (
    names.size >= 4 ||
    names.has("ttwid") ||
    names.has("passport_csrf_token") ||
    names.has("sid_guard") ||
    names.has("odin_tt")
  );
}

function maskSession(sessionId) {
  const id = normalizeSessionId(sessionId);
  if (!id || id.length < 12) return "(empty)";
  return `${id.slice(0, 6)}...${id.slice(-4)}`;
}

function emptyStore() {
  return { activeId: null, accounts: [], updatedAt: new Date().toISOString() };
}

function accountFromLegacy(data) {
  const sessionId = normalizeSessionId(data.sessionId || data.cookieHeader || "");
  if (!sessionId) return null;
  const cookieHeader =
    data.cookieHeader ||
    buildCookieHeader(data.cookies) ||
    `sessionid=${sessionId}; sessionid_ss=${sessionId}`;
  return {
    id: data.id || crypto.randomUUID(),
    label: data.label || maskSession(sessionId),
    sessionId,
    cookieHeader,
    source: data.source || "legacy",
    updatedAt: data.updatedAt || new Date().toISOString(),
    cooldownUntil: data.cooldownUntil || null,
    lastError: data.lastError || null,
  };
}

async function readStoreRaw() {
  try {
    const raw = await fs.readFile(config.sessionFile, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeStore(store) {
  await ensureDataDir();
  const payload = {
    ...store,
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(config.sessionFile, JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

/** 加载多账号仓库（兼容旧单账号格式） */
export async function loadStore() {
  const data = await readStoreRaw();
  if (!data) return emptyStore();

  if (Array.isArray(data.accounts)) {
    return {
      activeId: data.activeId || data.accounts[0]?.id || null,
      accounts: data.accounts.map((a) => accountFromLegacy(a)).filter(Boolean),
      updatedAt: data.updatedAt || new Date().toISOString(),
    };
  }

  // 旧格式：{ sessionId, cookieHeader }
  const acc = accountFromLegacy(data);
  if (!acc) return emptyStore();
  const store = { activeId: acc.id, accounts: [acc], updatedAt: acc.updatedAt };
  await writeStore(store);
  return store;
}

export function formatDuration(ms) {
  const n = Math.max(0, Math.floor(Number(ms) || 0));
  const sec = Math.floor(n / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}小时${m}分${String(s).padStart(2, "0")}秒`;
  if (m > 0) return `${m}分${String(s).padStart(2, "0")}秒`;
  return `${s}秒`;
}

export function getCooldownInfo(cooldownUntil, now = Date.now()) {
  if (!cooldownUntil) {
    return {
      cooling: false,
      cooldownRemainingMs: 0,
      cooldownRemainingText: "",
      cooldownUntil: null,
    };
  }
  const end = new Date(cooldownUntil).getTime();
  if (!Number.isFinite(end)) {
    return {
      cooling: false,
      cooldownRemainingMs: 0,
      cooldownRemainingText: "",
      cooldownUntil: null,
    };
  }
  const remain = end - now;
  if (remain <= 0) {
    return {
      cooling: false,
      cooldownRemainingMs: 0,
      cooldownRemainingText: "已到期",
      cooldownUntil,
    };
  }
  return {
    cooling: true,
    cooldownRemainingMs: remain,
    cooldownRemainingText: formatDuration(remain),
    cooldownUntil,
  };
}

/** 清除已到期的冷却，返回被恢复的账号数 */
export async function sweepExpiredCooldowns() {
  const store = await loadStore();
  const now = Date.now();
  let cleared = 0;
  for (const a of store.accounts) {
    if (!a.cooldownUntil) continue;
    const end = new Date(a.cooldownUntil).getTime();
    if (Number.isFinite(end) && end <= now) {
      a.cooldownUntil = null;
      a.lastError = null;
      a.updatedAt = new Date().toISOString();
      cleared += 1;
    }
  }
  if (cleared) await writeStore(store);
  return { cleared, checkedAt: new Date().toISOString() };
}

export async function clearAllCooldowns() {
  const store = await loadStore();
  let cleared = 0;
  for (const a of store.accounts) {
    if (a.cooldownUntil || a.lastError) {
      a.cooldownUntil = null;
      a.lastError = null;
      a.updatedAt = new Date().toISOString();
      cleared += 1;
    }
  }
  if (cleared) await writeStore(store);
  return { cleared };
}

export async function clearAccountCooldown(accountId) {
  const store = await loadStore();
  const acc = store.accounts.find((a) => a.id === accountId);
  if (!acc) throw new Error("账号不存在");
  acc.cooldownUntil = null;
  acc.lastError = null;
  acc.updatedAt = new Date().toISOString();
  await writeStore(store);
  return acc;
}

export async function listAccounts() {
  await sweepExpiredCooldowns();
  const store = await loadStore();
  const now = Date.now();
  return store.accounts.map((a) => {
    const cd = getCooldownInfo(a.cooldownUntil, now);
    return {
      id: a.id,
      label: a.label,
      masked: maskSession(a.sessionId),
      active: a.id === store.activeId,
      updatedAt: a.updatedAt,
      cooldownUntil: a.cooldownUntil,
      cooling: cd.cooling,
      cooldownRemainingMs: cd.cooldownRemainingMs,
      cooldownRemainingText: cd.cooldownRemainingText,
      statusText: cd.cooling
        ? `冷却中 · 剩余 ${cd.cooldownRemainingText}`
        : "可用",
      lastError: a.lastError,
      hasFullCookie: hasRichCookieHeader(a.cookieHeader),
    };
  });
}

export async function getActiveAccount() {
  const store = await loadStore();
  if (!store.accounts.length) return null;
  let acc = store.accounts.find((a) => a.id === store.activeId);
  if (!acc) acc = store.accounts[0];
  return acc;
}

/** 兼容旧调用：当前活跃账号 */
export async function loadSession() {
  const acc = await getActiveAccount();
  if (!acc) return null;
  return {
    sessionId: acc.sessionId,
    cookieHeader: acc.cookieHeader,
    updatedAt: acc.updatedAt,
    source: acc.source,
    id: acc.id,
    label: acc.label,
  };
}

/**
 * 新增或更新账号。
 * sessionIdOrCookie 可为纯 sessionid，或浏览器整段 Cookie。
 */
export async function upsertAccount(sessionIdOrCookie, extra = {}) {
  const store = await loadStore();
  const raw = String(sessionIdOrCookie || "").trim();
  const normalized = normalizeSessionId(raw);
  if (!normalized) throw new Error("sessionId 无效");

  let cookieHeader =
    extra.cookieHeader ||
    buildCookieHeader(extra.cookies) ||
    "";
  // 粘贴整段 Cookie 时必须保留完整头，否则只带 sessionid 极易被风控
  if (!cookieHeader) {
    if (/sessionid=/i.test(raw) && raw.includes(";")) {
      cookieHeader = buildCookieHeader(raw);
    } else {
      cookieHeader = `sessionid=${normalized}; sessionid_ss=${normalized}`;
    }
  }

  const existing = store.accounts.find((a) => a.sessionId === normalized);
  const now = new Date().toISOString();
  if (existing) {
    existing.cookieHeader = cookieHeader;
    existing.updatedAt = now;
    existing.source = extra.source || existing.source;
    existing.label = extra.label || existing.label || maskSession(normalized);
    // 刷新 Cookie 后清冷却（网页能用说明本地冷却可能过严）
    existing.cooldownUntil = null;
    existing.lastError = null;
    if (extra.setActive !== false) store.activeId = existing.id;
    await writeStore(store);
    return existing;
  }

  const acc = {
    id: crypto.randomUUID(),
    label: extra.label || `账号 ${maskSession(normalized)}`,
    sessionId: normalized,
    cookieHeader,
    source: extra.source || "manual",
    updatedAt: now,
    cooldownUntil: null,
    lastError: null,
  };
  store.accounts.push(acc);
  if (extra.setActive !== false) store.activeId = acc.id;
  await writeStore(store);
  return acc;
}

/** 兼容旧 API */
export async function saveSession(sessionId, extra = {}) {
  const acc = await upsertAccount(sessionId, { ...extra, setActive: true });
  return {
    sessionId: acc.sessionId,
    cookieHeader: acc.cookieHeader,
    updatedAt: acc.updatedAt,
    source: acc.source,
  };
}

export async function setActiveAccount(accountId) {
  const store = await loadStore();
  const acc = store.accounts.find((a) => a.id === accountId);
  if (!acc) throw new Error("账号不存在");
  store.activeId = acc.id;
  acc.cooldownUntil = null;
  acc.lastError = null;
  await writeStore(store);
  return acc;
}

export async function removeAccount(accountId) {
  const store = await loadStore();
  store.accounts = store.accounts.filter((a) => a.id !== accountId);
  if (store.activeId === accountId) {
    store.activeId = store.accounts[0]?.id || null;
  }
  await writeStore(store);
  return true;
}

export async function clearSession() {
  await writeStore(emptyStore());
}

/** 标记账号限流，并尽量切到下一个可用账号 */
/** 本地冷却：风控多为短暂，默认 3 分钟（非豆包官方倒计时） */
export async function markAccountRateLimited(accountId, message, cooldownMs = 3 * 60 * 1000) {
  const store = await loadStore();
  const acc = store.accounts.find((a) => a.id === accountId);
  if (!acc) return { switched: false, next: null };
  acc.cooldownUntil = new Date(Date.now() + cooldownMs).toISOString();
  acc.lastError = message || "rate limited";
  acc.updatedAt = new Date().toISOString();

  const next = store.accounts.find(
    (a) =>
      a.id !== accountId &&
      !(a.cooldownUntil && new Date(a.cooldownUntil).getTime() > Date.now())
  );
  if (next) store.activeId = next.id;
  await writeStore(store);
  return { switched: Boolean(next), next: next || null, limited: acc };
}

/** 取一个可用账号（跳过冷却中的） */
export async function pickAvailableAccount(preferId) {
  const store = await loadStore();
  const now = Date.now();
  const usable = (a) =>
    !(a.cooldownUntil && new Date(a.cooldownUntil).getTime() > now);

  if (preferId) {
    const preferred = store.accounts.find((a) => a.id === preferId && usable(a));
    if (preferred) return preferred;
  }
  const active = store.accounts.find((a) => a.id === store.activeId && usable(a));
  if (active) return active;
  return store.accounts.find(usable) || null;
}

export async function getSessionStatus() {
  const sweep = await sweepExpiredCooldowns();
  const store = await loadStore();
  const accounts = await listAccounts();
  const active = accounts.find((a) => a.active) || null;
  const coolingCount = accounts.filter((a) => a.cooling).length;
  return {
    ok: Boolean(active),
    live: null,
    masked: active?.masked || null,
    updatedAt: active?.updatedAt || store.updatedAt || null,
    sessionId: active ? (await getActiveAccount())?.sessionId : null,
    hasFullCookie: active?.hasFullCookie || false,
    activeId: store.activeId,
    accounts,
    accountCount: accounts.length,
    coolingCount,
    availableCount: accounts.length - coolingCount,
    checkedAt: sweep.checkedAt,
    clearedCooldowns: sweep.cleared,
  };
}

export { maskSession };
