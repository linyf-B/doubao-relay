# doubao-relay · 本地媒体网关

把 **豆包 / 即梦 / 可灵** 等网页额度，以及 **本机 Cursor**（编剧与大模型）、火山方舟等上游，统一成本机 **OpenAI 兼容 API**（默认 `http://127.0.0.1:8787/v1`）。在 **ToonFlow** 里可同时挂「豆包 / 即梦本地中转」做生图生视频，再挂 **「Cursor 编剧」** 用 Cursor 账号支持的 **Composer、Claude、GPT、Gemini、Kimi** 等文本模型写剧本。自带深色管理页：**账号池、本机试生成、成片记录、实时日志、ToonFlow 插件中心**。无 Docker，仅限个人自用。

![网关控制台：账号与登录](docs/console-account.png)

## 它解决什么问题

官方火山方舟要 Key、要计费；各平台网页版又难接工作流。本项目在本机起一个网关，用你自己的登录态调用网页能力（或内嵌即梦 SDK），再把结果以标准 HTTP 交给 **ToonFlow**、脚本或其它客户端。

```text
ToonFlow / 脚本 / 任意 OpenAI 客户端
        │  Authorization: Bearer LOCAL_API_KEY
        ▼
  :8787  doubao-relay（管理页 + /v1 API）
        ├─ 生图 / 生视频：多方案路由（doubao · jimeng · jimeng-api · kling · …）
        ├─ 编剧 / 大模型：cursor-relay → 本机 Cursor API（订阅额度，模型列表可同步）
        └─ 豆包对话：内部上游 :8000 doubao-free-api（npm start 一并拉起）
```

## 功能一览

| 模块 | 说明 |
|------|------|
| **网关控制台** | 顶栏切换「网关控制台 / ToonFlow 插件」，侧栏五块：账号、试生成、记录、日志、设置 |
| **多方案账号池** | 豆包 / 即梦 / 可灵分方案登录；切换、清冷却、删号；额度条实时刷新 |
| **本机试生成** | 文生图 / 文生视频，与 ToonFlow 共用接口；参考图 `@图N`、模型与比例下拉 |
| **生成记录** | 成片与 API 调用统一时间线，可下载、看提示词与模型信息 |
| **实时日志** | 按天日志文件 + 页面跟随 / 暂停 / 清空 |
| **ToonFlow 插件** | 内置供应商 `.ts` 列表、复制路径、按插件查看调用日志 |
| **Cursor 编剧桥接** | `cursor-relay.ts`：ToonFlow 文本任务走本机网关 → Cursor，可用账号内支持的各文本模型 |
| **OpenAI 兼容 API** | `/v1/images/generations`、`/v1/videos/generations`、`/v1/chat/completions` |
| **即梦 API 内嵌** | 进程内 SDK，**无需独立 :5100**；管理页登录即可，ToonFlow 不用填 SessionID |
| **CDP 抗风控** | 本机 Chrome/Edge 远程调试，降低豆包 `shark` / `710022004` |

## 快速开始

需要 **Node.js ≥ 22.13**（见 `package.json` engines）。Windows 示例：

```powershell
cd doubao
copy .env.example .env
npm run setup
npm start
```

浏览器打开 **http://127.0.0.1:8787**：

1. **网关控制台 → 账号与登录**：选豆包 / 即梦 / 可灵 → **登录当前方案**（或 **换账号登录** 加入账号池）
2. 顶栏 **ToonFlow 插件**：复制 `toonflow/doubaorelay.ts`、`jimeng-relay.ts`、`cursor-relay.ts` 等路径，在 ToonFlow **设置 → 模型服务 → 添加供应商** 导入；API 填 `LOCAL_API_KEY`，地址填 `http://127.0.0.1:8787/v1`
3. **要用 Cursor 模型**：在 [Cursor Dashboard → Integrations](https://cursor.com/dashboard/integrations) 创建密钥，写入 `.env` 的 `CURSOR_API_KEY`，重启 `npm start` 后在 ToonFlow 启用 **「Cursor 编剧」** 供应商（见下文）
4. 需要豆包视频抗风控时，在 **高级设置** 启用 CDP 或运行 `npm run start:cdp`

| 地址 | 说明 |
|------|------|
| http://127.0.0.1:8787 | 管理页与对外网关 |
| http://127.0.0.1:8787/v1 | OpenAI 兼容 API 根路径 |
| http://127.0.0.1:8000 | 豆包对话上游（仅本机，由 `npm start` 拉起） |

单独弹窗登录（命令行）：

```bash
npm run login
npm run login:switch   # 换账号，写入账号池
```

## 网关控制台

顶栏 **「网关控制台」** 左侧为五个子页，与截图一致。

### 账号与登录

![多方案额度与账号池](docs/console-providers.png)

- **方案卡片**：豆包（网页免费额度）、即梦（积分 / 每日免费）、可灵（每日次数）等；点选后下方为当前方案操作区
- **登录当前方案 / 换账号登录**：浏览器扫码或 CDP 窗口登录，会话写入 `data/`，**不要用豆包 sessionid 当 API Bearer**
- **账号池**：多账号列表、**切换**、单号 **清冷却**、删除；底部 **清空全部账号**
- 查询已配置上游：`GET /admin/providers`

### 本机试生成

![文生图 / 文生视频试跑](docs/console-studio.png)

- 与 ToonFlow **同一套 HTTP 接口**；顶栏显示当前方案与 **预计消耗**
- **文生图 / 文生视频** 页签；提示词支持 `@图1`、`@图2` 对应参考图顺序（最多 6 张）
- 模型（如 Seedream 5.0 Lite）、比例（16:9 等）；右侧为当前轮次对话/结果区
- 可展开 **原始 JSON** 便于对照请求体

### 生成记录

![成片与 API 调用记录](docs/console-activity.png)

- **实时同步** 开关；**清空** 仅清前端展示（日志文件仍按天保留）
- 每条记录含提示词、模型、比例、缩略图与 **下载** 链接

### 实时日志

![网关运行输出](docs/console-logs.png)

- 显示当前日志文件路径（默认 `data/logs/relay-YYYY-MM-DD.log`）
- **跟随 / 暂停 / 清空**；便于排查 provider 路由、额度估算、HTTP 耗时

### 高级设置

![密钥 · Cookie · CDP](docs/console-settings.png)

- **LOCAL_API_KEY** 与 **网关地址** `http://127.0.0.1:8787/v1`（多数场景只配这一项即可）
- **手动粘贴 Cookie（备用）**：优先用页面登录；纯 Cookie 易触发风控
- **CDP 调试（抗风控）**：状态、**启动 CDP 浏览器**；亦可 `npm run start:cdp` 或按页内 PowerShell 示例启动 Edge/Chrome `:9222`

`.env` 常用 CDP：

```env
DOUBAO_USE_CDP=1
DOUBAO_CDP_URL=http://127.0.0.1:9222
```

## ToonFlow 插件中心

顶栏 **「ToonFlow 插件」** 列出 `toonflow/` 下各供应商脚本，支持 **复制路径**、查看 **调用日志**（与 ToonFlow 请求实时同步）。

| 文件 | 说明 |
|------|------|
| [`cursor-relay.ts`](toonflow/cursor-relay.ts) | Composer / Claude / Kimi 等，走 **Cursor 订阅**；`.env` 配置 `CURSOR_API_KEY` |
| [`jimeng-relay.ts`](toonflow/jimeng-relay.ts) | 即梦生图 + 生视频（内嵌 API）；管理页登录即可 |
| [`doubaorelay.ts`](toonflow/doubaorelay.ts) | 豆包对话 + 多方案生图/视频合一，可配置 provider 路由 |
| [`kling-relay.ts`](toonflow/kling-relay.ts) | 可灵网页 |
| [`volcengine-relay.ts`](toonflow/volcengine-relay.ts) | 火山方舟 Ark |
| [`metaso-minimax-h3.ts`](toonflow/metaso-minimax-h3.ts) | 秘塔 MiniMax-H3 |
| [`tencent-tokenhub-image.ts`](toonflow/tencent-tokenhub-image.ts) | 腾讯 TokenHub 混元 |

![Cursor 编剧插件](docs/plugins-cursor.png)

![豆包全功能插件与调用日志](docs/plugins-doubaorelay.png)

![即梦 API 插件](docs/plugins-jimeng.png)

更细的导入步骤见 [`toonflow/README.md`](toonflow/README.md)。

### 在 ToonFlow 中同时挂本地中转与 Cursor

ToonFlow **设置 → 模型服务** 里可并行启用多个供应商：生图/生视频走 **豆包本地中转**、**即梦·本地中转**，编剧与 Agent 文本走 **Cursor 编剧**（均指向本机 `8787`，不混用网页 SessionID）。

![ToonFlow 模型服务：豆包 / 即梦 / Cursor 编剧](docs/toonflow-model-services-overview.png)

典型组合（与上图一致）：

- **豆包本地中转** / **即梦·本地中转**：Seedream、Seedance、即梦 4.0 等图像/视频模型（需在网关管理页登录对应平台）
- **Cursor 编剧**：仅 **文本模型**；模型卡片来自 Cursor 账号能力（如 Composer 2.5、Claude Opus、GPT、Gemini Flash、Kimi K3 Max 等）

![ToonFlow：豆包与即梦本地中转供应商](docs/toonflow-providers-doubao-jimeng.png)

![ToonFlow：Cursor 编剧可用文本模型](docs/toonflow-cursor-models.png)

### 接入本地 Cursor（`cursor-relay.ts`）

网关把 ToonFlow 的文本请求转发到 **Cursor Cloud Agents API**（消耗 Cursor 订阅额度），适合漫剧编剧、分场、对白、分镜文案。生图/生视频请仍用 `jimeng-relay.ts` 或 `doubaorelay.ts`。

1. 在 `doubao/.env` 配置（示例见 [`.env.example`](.env.example)）：

   ```env
   CURSOR_API_KEY=cursor_...
   CURSOR_RUNTIME=cloud
   ```

   - `cloud`：纯文本编剧（推荐，无需绑定仓库）
   - `local`：可配合 `CURSOR_CWD` 让 Agent 读写本地项目目录

2. `npm start` 后，管理页 **ToonFlow 插件** 复制 `toonflow/cursor-relay.ts` 路径 → ToonFlow 导入供应商
3. 供应商内填 **`LOCAL_API_KEY`** + **`http://127.0.0.1:8787/v1`**（不是 Cursor 密钥；Cursor 密钥只写在网关 `.env`）
4. 在 ToonFlow 编剧/文本任务里选择 **Cursor 编剧** 下的模型；可用列表也可查：`GET http://127.0.0.1:8787/admin/cursor/models`

管理页 **「Cursor 编剧」** 插件卡片与调用日志见上文 [`plugins-cursor.png`](docs/plugins-cursor.png)。

### 接入步骤（通用）

1. `npm start`，在管理页为对应平台 **登录**
2. ToonFlow → 导入供应商 → 选择 `toonflow/*.ts`（已导入可 **检查更新** 或重新导入）
3. **API 密钥** = `.env` 的 `LOCAL_API_KEY`
4. **请求地址** = `http://127.0.0.1:8787/v1`
5. 使用 `doubaorelay.ts` 时可在插件配置里指定 **生图/生视频方案**（`doubao`、`jimeng-api`、`kling` 等），留空则用 `.env` 默认

## 调用 API

鉴权：`Authorization: Bearer <LOCAL_API_KEY>`。

### 文生图

```bash
curl http://127.0.0.1:8787/v1/images/generations ^
  -H "Authorization: Bearer local-dev-key-change-me" ^
  -H "Content-Type: application/json" ^
  -d "{\"model\":\"Seedream 5.0 Lite\",\"prompt\":\"一只戴墨镜的橘猫，赛博朋克霓虹\",\"ratio\":\"16:9\"}"
```

多参考图：`images` 数组 + 提示词 `@图1`、`@图2`；网关会映射为平台占位并注入角色锁定规则。

### 文生视频

```bash
curl http://127.0.0.1:8787/v1/videos/generations ^
  -H "Authorization: Bearer local-dev-key-change-me" ^
  -H "Content-Type: application/json" ^
  -d "{\"model\":\"Seedance 2.5\",\"prompt\":\"橘猫走过霓虹街道\",\"duration\":5,\"ratio\":\"16:9\"}"
```

同步等待结果，超时可达数分钟。别名：`/v1/videos`、`/v1/video/generations`。

### 多方案路由

支持 **doubao**、**jimeng**、**jimeng-api**、**kling**、**volcengine**、**openai** 等；`.env` 设默认与 failover，或请求体 / Header 覆盖：

```json
{ "provider": "jimeng-api", "prompt": "@图1 为角色立绘…", "ratio": "16:9", "images": ["…"] }
```

`X-Image-Provider` / `X-Video-Provider` 亦可。

### 对话（豆包）

```bash
curl http://127.0.0.1:8787/v1/chat/completions ^
  -H "Authorization: Bearer local-dev-key-change-me" ^
  -H "Content-Type: application/json" ^
  -d "{\"model\":\"doubao\",\"messages\":[{\"role\":\"user\",\"content\":\"你好\"}]}"
```

### 对话（Cursor 编剧）

需已配置 `CURSOR_API_KEY`。`model` 填 ToonFlow/Cursor 支持的模型名（如 `composer-2.5`），或由网关默认 `CURSOR_DEFAULT_MODEL` 决定：

```bash
curl http://127.0.0.1:8787/v1/chat/completions ^
  -H "Authorization: Bearer local-dev-key-change-me" ^
  -H "Content-Type: application/json" ^
  -H "X-Provider: cursor" ^
  -d "{\"model\":\"composer-2.5\",\"messages\":[{\"role\":\"user\",\"content\":\"写一场古风对峙戏，对白简短\"}]}"
```

## 常用命令

| 命令 | 作用 |
|------|------|
| `npm start` | 上游 free-api + 网关（含内嵌即梦 API） |
| `npm run gateway` | 仅网关 |
| `npm run upstream` | 仅 doubao-free-api |
| `npm run login` | 弹窗登录 |
| `npm run login:switch` | 换账号加入池 |
| `npm run start:cdp` | 启动 CDP 调试浏览器 |
| `npm run setup` | 依赖 + Playwright + 构建上游与 jimeng-api |

## 环境变量

见 [`.env.example`](.env.example)。常用项：

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | `8787` | 网关端口 |
| `LOCAL_API_KEY` | `local-dev-key-change-me` | 客户端 Bearer |
| `UPSTREAM_URL` | `http://127.0.0.1:8000` | 豆包对话上游 |
| `IMAGE_PROVIDER` / `VIDEO_PROVIDER` | `doubao` | 默认生图/视频方案 |
| `JIMENG_API_ENABLED` | `1` | 内嵌即梦 SDK |
| `CURSOR_API_KEY` | — | Cursor 编剧；在 Cursor Dashboard 创建 |
| `CURSOR_RUNTIME` | `cloud` | `cloud` 纯文本 / `local` 可绑 `CURSOR_CWD` 项目 |
| `DOUBAO_USE_CDP` | — | `1` 启用 CDP |
| `LOG_DIR` | `data/logs` | 按天日志 |

勿提交 `data/`、`.env`、`vendor/**/node_modules`。

## 旧版文档

改版前的 README 全文备份在 [`docs/README.legacy.md`](docs/README.legacy.md)。

## 免责声明

- 非官方接口，网页改版即可能失效。
- **仅限个人自用学习**，禁止对外服务或商用。
- 稳定生产请用各平台官方 API（如 [火山引擎豆包](https://www.volcengine.com/product/doubao)）。
