import http from "node:http";

const body = JSON.stringify({
  model: "Seedance 2.0 Mini",
  prompt: "一只小猫在草地上跑",
  duration: 5,
  ratio: "16:9",
});

const t0 = Date.now();
const req = http.request(
  {
    hostname: "127.0.0.1",
    port: 8787,
    path: "/v1/videos/generations",
    method: "POST",
    headers: {
      Authorization: "Bearer local-dev-key-change-me",
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
    timeout: 600000,
  },
  (res) => {
    let data = "";
    res.on("data", (c) => (data += c));
    res.on("end", () => {
      console.log("status", res.statusCode, "ms", Date.now() - t0);
      console.log(data.slice(0, 2000));
    });
  }
);
req.on("error", (e) => {
  console.error("ERR", e.message, Date.now() - t0);
});
req.write(body);
req.end();
