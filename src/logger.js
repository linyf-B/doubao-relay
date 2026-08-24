import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { config } from "./config.js";

const bus = new EventEmitter();
bus.setMaxListeners(50);

const ring = [];
const RING_MAX = 800;

function todayStamp() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function ensureLogDirSync() {
  fs.mkdirSync(config.logDir, { recursive: true });
}

function logFilePath(day = todayStamp()) {
  return path.join(config.logDir, `relay-${day}.log`);
}

function formatLine(level, msg, meta) {
  const ts = new Date().toISOString();
  let line = `${ts} [${level}] ${msg}`;
  if (meta != null && meta !== "") {
    try {
      const { previews: _p, ...rest } =
        typeof meta === "object" && meta && !Array.isArray(meta) ? meta : { value: meta };
      const extra =
        typeof meta === "string"
          ? meta
          : JSON.stringify(Object.keys(rest).length ? rest : {});
      if (extra && extra !== "{}" && extra !== "null") {
        line += ` ${extra}`;
      }
    } catch {
      line += ` ${String(meta)}`;
    }
  }
  return line;
}

function pushRing(entry) {
  ring.push(entry);
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
  bus.emit("line", entry);
}

function writeFile(line) {
  try {
    ensureLogDirSync();
    fs.appendFileSync(logFilePath(), `${line}\n`, "utf8");
  } catch (err) {
    process.stderr.write(`[logger] write failed: ${err.message}\n`);
  }
}

function normalizeEntry(entry) {
  if (typeof entry === "string") return { line: entry };
  if (entry && typeof entry === "object" && entry.line) return entry;
  return { line: String(entry) };
}

function log(level, msg, meta) {
  const line = formatLine(level, msg, meta);
  const previews =
    meta && typeof meta === "object" && Array.isArray(meta.previews)
      ? meta.previews.filter(Boolean)
      : null;
  const entry = previews?.length ? { line, previews } : { line };
  pushRing(entry);
  writeFile(line);
  const out = level === "ERROR" || level === "WARN" ? process.stderr : process.stdout;
  out.write(`${line}\n`);
  return line;
}

export const logger = {
  info: (msg, meta) => log("INFO", msg, meta),
  warn: (msg, meta) => log("WARN", msg, meta),
  error: (msg, meta) => log("ERROR", msg, meta),
  debug: (msg, meta) => {
    if (String(process.env.LOG_DEBUG || "").trim() === "1") {
      return log("DEBUG", msg, meta);
    }
    return null;
  },
  filePath: () => logFilePath(),
  dir: () => config.logDir,
  recent: (n = 200) =>
    ring.slice(-Math.max(1, Math.min(n, RING_MAX))).map(normalizeEntry),
  onLine: (fn) => {
    const wrapped = (entry) => fn(normalizeEntry(entry));
    bus.on("line", wrapped);
    return () => bus.off("line", wrapped);
  },
};

/** 读取今日日志文件末尾若干行（磁盘） */
export async function readLogTail(lines = 200) {
  const file = logFilePath();
  try {
    const text = await fsp.readFile(file, "utf8");
    const all = text.split(/\r?\n/).filter(Boolean);
    return {
      ok: true,
      file,
      lines: all.slice(-Math.max(1, Math.min(lines, 2000))),
    };
  } catch (err) {
    if (err.code === "ENOENT") {
      return { ok: true, file, lines: logger.recent(lines).map((e) => e.line) };
    }
    return { ok: false, file, message: String(err.message || err), lines: [] };
  }
}

ensureLogDirSync();
logger.info("logger ready", { file: logFilePath() });
