const $ = (id) => document.getElementById(id);

let latestAccounts = [];
let countdownTimer = null;

function defaultKey() {
  return localStorage.getItem("doubao_local_api_key") || "local-dev-key-change-me";
}

$("apiKey").value = defaultKey();
$("apiKey").addEventListener("change", () => {
  localStorage.setItem("doubao_local_api_key", $("apiKey").value.trim());
  renderCurl();
});

function renderCurl() {
  const key = $("apiKey").value.trim() || "local-dev-key-change-me";
  $("curlHint").textContent = `curl http://127.0.0.1:8787/v1/images/generations \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d "{\\"model\\":\\"Seedream 4.5\\",\\"prompt\\":\\"一只猫\\",\\"ratio\\":\\"1:1\\"}"`;
}

function formatDuration(ms) {
  const n = Math.max(0, Math.floor(Number(ms) || 0));
  const sec = Math.floor(n / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}小时${m}分${String(s).padStart(2, "0")}秒`;
  if (m > 0) return `${m}分${String(s).padStart(2, "0")}秒`;
  return `${s}秒`;
}

function localCooldownText(a) {
  if (!a?.cooldownUntil) return a?.statusText || "可用";
  const remain = new Date(a.cooldownUntil).getTime() - Date.now();
  if (remain <= 0) return "冷却已到期，等待扫描恢复…";
  return `冷却中 · 剩余 ${formatDuration(remain)}`;
}

function renderAccounts(accounts = latestAccounts) {
  latestAccounts = accounts;
  const box = $("accounts");
  if (!accounts.length) {
    box.innerHTML = '<p class="hint">暂无账号。请先「登录豆包」或「换账号登录」。</p>';
    return;
  }
  box.innerHTML = accounts
    .map((a) => {
      const tags = [];
      if (a.active) tags.push("当前");
      if (!a.hasFullCookie) tags.push("仅session");
      const statusLine = localCooldownText(a);
      const err = a.cooling && a.lastError ? `<div class="hint err">${a.lastError}</div>` : "";
      return `<div class="account-row ${a.active ? "active" : ""} ${a.cooling ? "cooling" : ""}">
        <div>
          <strong>${a.label || a.masked}</strong>
          <span class="hint"> ${a.masked}</span>
          <div class="hint">${tags.join(" · ")}</div>
          <div class="cooldown" data-cd="${a.id}">${statusLine}</div>
          ${err}
        </div>
        <div class="row">
          <button type="button" data-act="use" data-id="${a.id}" ${a.active ? "disabled" : ""}>切换</button>
          <button type="button" data-act="clearcd" data-id="${a.id}" ${a.cooling ? "" : "disabled"}>清除冷却</button>
          <button type="button" class="danger" data-act="del" data-id="${a.id}">删除</button>
        </div>
      </div>`;
    })
    .join("");

  box.querySelectorAll("button[data-act]").forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.getAttribute("data-id");
      const act = btn.getAttribute("data-act");
      if (act === "use") {
        await fetch("/admin/accounts/active", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
        });
      } else if (act === "del") {
        await fetch(`/admin/accounts/${id}`, { method: "DELETE" });
      } else if (act === "clearcd") {
        await fetch(`/admin/accounts/${id}/clear-cooldown`, { method: "POST" });
      }
      refreshStatus();
    };
  });
}

function tickCountdowns() {
  let needRefresh = false;
  for (const a of latestAccounts) {
    const el = document.querySelector(`[data-cd="${a.id}"]`);
    if (!el) continue;
    if (!a.cooldownUntil) {
      el.textContent = "可用";
      continue;
    }
    const remain = new Date(a.cooldownUntil).getTime() - Date.now();
    if (remain <= 0) {
      el.textContent = "冷却已到期，等待扫描恢复…";
      needRefresh = true;
    } else {
      el.textContent = `冷却中 · 剩余 ${formatDuration(remain)}`;
    }
  }
  if (needRefresh) refreshStatus(true);
}

async function refreshStatus(silent = false) {
  try {
    const r = await fetch("/admin/accounts/check", { method: "POST" });
    const data = await r.json();
    renderAccounts(data.accounts || []);
    const hint = [];
    if (data.availableCount != null) {
      hint.push(`可用 ${data.availableCount}/${data.accountCount || 0}`);
    }
    if (data.clearedCooldowns > 0) hint.push(`已自动恢复 ${data.clearedCooldowns} 个冷却账号`);
    if (data.coolingCount > 0) hint.push(`冷却中 ${data.coolingCount} 个`);
    if (!silent || hint.length) $("loginHint").textContent = hint.join(" · ");
  } catch (err) {
    if (!silent) $("loginHint").textContent = String(err);
  }
}

async function doLogin(switchAccount) {
  const btn = switchAccount ? $("btnSwitch") : $("btnLogin");
  btn.disabled = true;
  $("loginHint").textContent = switchAccount
    ? "正在打开干净浏览器，请用新账号登录…"
    : "正在打开浏览器，请登录豆包…";
  try {
    const r = await fetch("/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ switchAccount: Boolean(switchAccount) }),
    });
    const data = await r.json();
    $("loginHint").textContent = data.ok
      ? `登录成功：${data.masked}`
      : `失败：${data.message || JSON.stringify(data)}`;
  } catch (err) {
    $("loginHint").textContent = String(err);
  } finally {
    btn.disabled = false;
    refreshStatus();
  }
}

$("btnRefresh").onclick = () => refreshStatus(false);
$("btnLogin").onclick = () => doLogin(false);
$("btnSwitch").onclick = () => doLogin(true);

$("btnClear").onclick = async () => {
  await fetch("/admin/session", { method: "DELETE" });
  $("loginHint").textContent = "已清空全部账号";
  refreshStatus();
};

$("btnSaveSession").onclick = async () => {
  const sessionId = $("sessionInput").value.trim();
  const r = await fetch("/admin/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  const data = await r.json();
  $("loginHint").textContent = data.ok
    ? `已保存：${data.masked} · Cookie ${data.cookieCount || "?"} 项 · hasFullCookie=${data.hasFullCookie}`
    : data.message;
  if (data.ok) $("sessionInput").value = "";
  refreshStatus();
};

$("btnClearCd").onclick = async () => {
  const r = await fetch("/admin/accounts/clear-cooldowns", { method: "POST" });
  const data = await r.json();
  $("loginHint").textContent = data.ok
    ? `已清除 ${data.cleared || 0} 个账号的本地冷却`
    : data.message || "清除失败";
  refreshStatus();
};

$("btnGen").onclick = async () => {
  const key = $("apiKey").value.trim();
  localStorage.setItem("doubao_local_api_key", key);
  $("genOut").textContent = "请求中…";
  $("images").innerHTML = "";
  try {
    const r = await fetch("/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: $("model").value,
        prompt: $("prompt").value.trim(),
        ratio: $("ratio").value,
        style: "默认",
        stream: false,
      }),
    });
    const data = await r.json();
    $("genOut").textContent = JSON.stringify(data, null, 2);

    if (data?.error?.needSwitchAccount || data?.error?.type === "rate_limited") {
      $("loginHint").textContent =
        "触发限流：请点「换账号登录」添加新号，或等待冷却结束后自动恢复。";
    }

    const urls = [];
    if (Array.isArray(data?.data)) {
      for (const item of data.data) if (item?.url) urls.push(item.url);
    }
    const nested = data?.choices?.[0]?.message?.images;
    if (Array.isArray(nested)) urls.push(...nested.filter((u) => typeof u === "string"));

    for (const url of urls) {
      const img = document.createElement("img");
      img.src = url;
      img.alt = "generated";
      $("images").appendChild(img);
    }
  } catch (err) {
    $("genOut").textContent = String(err);
  } finally {
    refreshStatus();
  }
};

renderCurl();
refreshStatus();
countdownTimer = setInterval(tickCountdowns, 1000);
setInterval(() => refreshStatus(true), 10000);

let logEs = null;
let logFollow = true;
const logView = $("logView");

function appendLogEntry(entry) {
  if (!logView) return;
  const line = typeof entry === "string" ? entry : entry?.line || "";
  const previews = Array.isArray(entry?.previews) ? entry.previews : [];

  const row = document.createElement("div");
  row.className = "log-row";

  const text = document.createElement("div");
  text.className = "log-line";
  text.textContent = line;
  row.appendChild(text);

  if (previews.length) {
    const strip = document.createElement("div");
    strip.className = "log-previews";
    previews.forEach((src, i) => {
      const fig = document.createElement("figure");
      fig.className = "log-preview";
      const img = document.createElement("img");
      img.src = src;
      img.alt = `@图${i + 1}`;
      img.loading = "lazy";
      const cap = document.createElement("figcaption");
      cap.textContent = `@图${i + 1}`;
      fig.appendChild(img);
      fig.appendChild(cap);
      strip.appendChild(fig);
    });
    row.appendChild(strip);
  }

  logView.appendChild(row);
  while (logView.children.length > 400) {
    logView.removeChild(logView.firstChild);
  }
  if (logFollow) logView.scrollTop = logView.scrollHeight;
}

function startLogStream() {
  if (logEs) logEs.close();
  logEs = new EventSource("/admin/logs/stream");
  $("logLiveStatus").textContent = "连接中…";
  logEs.onopen = () => {
    $("logLiveStatus").textContent = "实时中";
  };
  logEs.addEventListener("meta", (ev) => {
    try {
      const m = JSON.parse(ev.data);
      if (m.file) $("logFilePath").textContent = m.file;
    } catch {
      // ignore
    }
  });
  logEs.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data);
      appendLogEntry(data);
    } catch {
      appendLogEntry(ev.data);
    }
  };
  logEs.onerror = () => {
    $("logLiveStatus").textContent = "断开，重连中…";
  };
}

$("btnLogFollow").onclick = () => {
  logFollow = true;
  logView.scrollTop = logView.scrollHeight;
  $("logLiveStatus").textContent = "跟随最新";
  if (!logEs || logEs.readyState === EventSource.CLOSED) startLogStream();
};

$("btnLogPause").onclick = () => {
  logFollow = false;
  $("logLiveStatus").textContent = "已暂停滚动";
};

$("btnLogClear").onclick = () => {
  logView.innerHTML = "";
};

startLogStream();
