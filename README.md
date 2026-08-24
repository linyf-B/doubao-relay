# 豆包本地中转（doubao-relay）

把豆包网页版变成 **本机 OpenAI 兼容 API**：多账号轮换、Seedream 文生图、Seedance 文生视频，以及多参考图角色一致性。无需 Docker，仅限个人自用。

![管理页：实时日志与参考图核对](docs/dashboard.png)

## 它解决什么问题

官方火山方舟要 Key、要计费；网页版又不好接工作流。本项目在本机开一个网关（默认 `:8787`），用你自己的豆包登录态去调网页能力，再把结果以标准 HTTP 接口交给 Toonflow、脚本或其它客户端。

```text
客户端 / Toonflow
        │  Bearer LOCAL_API_KEY
        ▼
  :8787  豆包本地中转
        │  注入 session / Cookie，限流自动换号
        ├─ 文生图 / 视频：本机浏览器或 CDP 直连豆包网页
        └─ 对话：:8000 doubao-free-api（本机 Node）
```

## 功能一览

| 能力 | 说明 |
|------|------|
| **多账号池** | 登录多个豆包号，限流自动跳过冷却并轮换 |
| **OpenAI 兼容 API** | `/v1/images/generations`、`/v1/videos/generations`、`/v1/chat/completions` |
| **Seedream 文生图** | 5.0 Lite / 5.0 / 4.5 / 4.0；比例 1:1、16:9、9:16、4:3、3:4 |
| **角色一致性** | 参考图映射为 `@图N`，自动注入五官/服饰锁定与防串脸规则 |
| **Seedance 文生视频** | 2.5 / 2.0 / Fast / Mini；同步等待，最长约数分钟 |
| **管理页** | 登录、换号、冷却、SSE 实时日志、本机试生成 |
| **CDP 抗风控** | 连接本机 Chrome/Edge 调试端口，降低 shark / 710022004 |

## 快速开始

需要 Node.js 18+。Windows 示例：

```bash
cd doubao
copy .env.example .env
npm run setup
npm start
```

浏览器打开 http://127.0.0.1:8787 → 点 **「登录豆包」** 完成扫码。若报 `shark` / `710022004`，改用本机 Chrome/Edge 调试登录（见下文）。

- 管理页：http://127.0.0.1:8787
- 上游 free-api：http://127.0.0.1:8000（`npm start` 会一并拉起）

单独弹窗登录：

```bash
npm run login
```

## 管理页

![账号池：切换、清冷却、删除](docs/accounts.png)

- **登录豆包 / 换账号登录**：弹窗扫码，会话写入 `data/session.json`
- **账号池**：切换当前号、清除冷却、删除单个账号
- **实时日志**：SSE 推送，上传参考图时显示缩略图，便于核对 `@图N`
- **试一下文生图**：选模型与比例，直接在页面出图

![本机试生成与 curl 示例](docs/generate.png)

## 调用 API

鉴权一律使用 `.env` 里的 `LOCAL_API_KEY`（不要拿豆包 `sessionid` 当 Bearer）。

### 文生图

```bash
curl http://127.0.0.1:8787/v1/images/generations ^
  -H "Authorization: Bearer local-dev-key-change-me" ^
  -H "Content-Type: application/json" ^
  -d "{\"model\":\"Seedream 4.5\",\"prompt\":\"一只戴墨镜的橘猫，赛博朋克霓虹，电影感\",\"ratio\":\"1:1\"}"
```

多参考图时，把图片放进 `images`（base64 或 URL），提示词用 `@图1`、`@图2` 对应附件顺序。网关会把占位统一成豆包的 `@图片N`，并注入角色锁定规则。

```json
{
  "model": "Seedream 4.5",
  "prompt": "@图1 为江彻角色，@图2 为办公室，江彻坐在工位上看信封",
  "ratio": "16:9",
  "images": ["data:image/png;base64,...", "data:image/png;base64,..."]
}
```

### 文生视频

```bash
curl http://127.0.0.1:8787/v1/videos/generations ^
  -H "Authorization: Bearer local-dev-key-change-me" ^
  -H "Content-Type: application/json" ^
  -d "{\"model\":\"Seedance 2.0\",\"prompt\":\"一只橘猫戴墨镜走过霓虹街道\",\"duration\":5,\"ratio\":\"16:9\"}"
```

接口会同步等待结果，超时约数分钟。也可用 `/v1/videos`、`/v1/video/generations`。

### 对话

```bash
curl http://127.0.0.1:8787/v1/chat/completions ^
  -H "Authorization: Bearer local-dev-key-change-me" ^
  -H "Content-Type: application/json" ^
  -d "{\"model\":\"doubao\",\"messages\":[{\"role\":\"user\",\"content\":\"你好\"}]}"
```

## 本机浏览器调试（抗风控）

豆包会校验浏览器指纹，只贴 Cookie 很容易被拦。推荐用本机 Chrome 或 Edge 开远程调试，在弹出窗口里登录。

`.env`：

```env
DOUBAO_USE_CDP=1
DOUBAO_CDP_URL=http://127.0.0.1:9222
```

PowerShell 启动 Edge（推荐）：

```powershell
$dir = "$env:TEMP\doubao-cdp"; New-Item -ItemType Directory -Force -Path $dir | Out-Null
& "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222 --user-data-dir=$dir "https://www.doubao.com/chat/"
```

Chrome：

```powershell
$dir = "$env:TEMP\doubao-cdp"; New-Item -ItemType Directory -Force -Path $dir | Out-Null
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir=$dir "https://www.doubao.com/chat/"
```

改完 `.env` 后重启 `npm start`。登录请在**弹出的浏览器窗口**操作，不要用平时日常资料目录。

## Toonflow 接入

导入 [`toonflow/doubaorelay.ts`](toonflow/doubaorelay.ts)：

1. `npm start` 并在管理页登录豆包
2. Toonflow → 导入供应商 → 选择该文件
3. API 密钥填 `.env` 的 `LOCAL_API_KEY`
4. 请求地址填 `http://127.0.0.1:8787/v1`

支持对话、Seedream 多参考图、Seedance 视频。限流时在管理页点 **「换账号登录」** 加号；生图会自动跳过冷却账号。

## 常用命令

| 命令 | 作用 |
|------|------|
| `npm start` | 同时启动上游 + 网关 |
| `npm run gateway` | 只开网关 |
| `npm run upstream` | 只开 free-api |
| `npm run login` | 弹窗登录抓 session |
| `npm run login:switch` | 换账号登录（加入账号池） |
| `npm run setup` | 安装依赖并构建上游 |

## 环境变量

见 [`.env.example`](.env.example)。常用项：

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | `8787` | 网关端口 |
| `LOCAL_API_KEY` | `local-dev-key-change-me` | 客户端 Bearer |
| `UPSTREAM_URL` | `http://127.0.0.1:8000` | 对话上游 |
| `DOUBAO_USE_CDP` | — | 设为 `1` 走本机浏览器调试 |
| `DOUBAO_CDP_URL` | `http://127.0.0.1:9222` | CDP 地址 |
| `LOG_DIR` | `data/logs` | 按天切分的日志 |
| `BROWSER_PROFILE_DIR` | `data/browser-profile` | Playwright 用户数据 |

勿提交 `data/`、`.env`、`vendor/**/node_modules`。

## 免责声明

- 非官方接口，网页改版即可能失效。
- **仅限个人自用学习**，禁止对外服务或商用。
- 稳定生产请用 [火山引擎官方 API](https://www.volcengine.com/product/doubao)。
