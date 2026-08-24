/**
 * Cookie 工具
 */

export function parseCookieHeaderToPlaywright(cookieHeader, domain = ".doubao.com") {
  const text = String(cookieHeader || "").trim();
  if (!text) return [];
  const out = [];
  for (const part of text.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!name) continue;
    out.push({
      name,
      value,
      domain,
      path: "/",
    });
  }
  return out;
}

export function getCookieValue(cookieHeader, name) {
  const re = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`, "i");
  const m = String(cookieHeader || "").match(re);
  return m ? decodeURIComponent(m[1]) : "";
}
