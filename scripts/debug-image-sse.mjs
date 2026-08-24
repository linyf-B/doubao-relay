import fs from "node:fs/promises";
import crypto from "node:crypto";

const session = JSON.parse(await fs.readFile("data/session.json", "utf8")).sessionId;
const ASSISTANT_ID = "497858";
const DEVICE_ID = `7${String(Math.random()).slice(2, 20)}`;
const WEB_ID = `7${String(Math.random()).slice(2, 20)}`;

const qs = new URLSearchParams({
  aid: ASSISTANT_ID,
  device_id: DEVICE_ID,
  device_platform: "web",
  language: "zh",
  pc_version: "2.44.0",
  pkg_type: "release_version",
  real_aid: ASSISTANT_ID,
  region: "CN",
  samantha_web: "1",
  sys_region: "CN",
  tea_uuid: WEB_ID,
  "use-olympus-account": "1",
  version_code: "20800",
  web_id: WEB_ID,
  web_tab_id: crypto.randomUUID(),
});

const content = JSON.stringify({
  text: "帮我生成图片：一只戴墨镜的橘猫\n风格：默认\n比例：1:1",
  model: "Seedream 4.5",
  template_type: "placeholder",
  use_creation: false,
});

const body = {
  messages: [
    {
      content,
      content_type: 2009,
      attachments: [],
      references: [],
      skill: {
        skill_type: 3,
        skill_type_no_default: 3,
        skill_id: "3",
        skill_id_no_default: "3",
      },
    },
  ],
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
    action_bar_skill_id: 3,
  },
  evaluate_option: { web_ab_params: "" },
  local_conversation_id: crypto.randomUUID(),
  local_message_id: crypto.randomUUID(),
};

const url = `https://www.doubao.com/samantha/chat/completion?${qs}`;
const res = await fetch(url, {
  method: "POST",
  headers: {
    Accept: "*/*",
    "Content-Type": "application/json",
    Cookie: `sessionid=${session}; sessionid_ss=${session}`,
    Origin: "https://www.doubao.com",
    Referer: "https://www.doubao.com/chat/",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "agw-js-conv": "str",
  },
  body: JSON.stringify(body),
});

const text = await res.text();
await fs.writeFile("data/raw-image-sse.txt", text, "utf8");
console.log("HTTP", res.status, "len", text.length, "ct", res.headers.get("content-type"));

const ctypes = new Set();
const urls = [];
for (const block of text.split("\n")) {
  if (!block.startsWith("data:")) continue;
  const raw = block.slice(5).trim();
  if (!raw || raw === "[DONE]") continue;
  try {
    const ev = JSON.parse(raw);
    let ed = ev.event_data;
    if (typeof ed === "string") {
      try {
        ed = JSON.parse(ed);
      } catch {}
    }
    const msg = ed?.message;
    if (msg?.content_type != null) ctypes.add(msg.content_type);
    const c = typeof msg?.content === "string" ? msg.content : "";
    if (/https?:\/\//.test(c)) {
      const m = c.match(/https?:\/\/[^"\\\s]+/g);
      if (m) urls.push(...m.slice(0, 3));
    }
    if (typeof msg?.content === "string") {
      try {
        const parsed = JSON.parse(msg.content);
        if (parsed?.creations) console.log("creations", msg.content_type, parsed.creations?.length);
        if (Array.isArray(parsed?.data)) console.log("data[]", msg.content_type, parsed.data.length);
      } catch {}
    }
  } catch {}
}
console.log("content_types", [...ctypes]);
console.log("sample_urls", urls.slice(0, 5));
console.log("head", text.slice(0, 500));
