# Forge — 把想法锻造成可上线的网站

基于 Cloudflare 的 AI 应用生成平台(atoms.dev 简化版):用户描述想法 → AI 两阶段「规划 → 编码」→ 生成真实可上线的单文件网站 → 一键发布 → 分享 `/s/<slug>` 公开链接。

## 功能

- 落地页:价值主张 + 大输入框 + 示例想法
- 邮箱密码注册/登录,注册送 20 积分,每次生成扣 1 积分
- 工作台:左侧聊天展示「规划 → 编码」过程流,右侧 iframe 实时预览(桌面/移动)+ 代码查看
- 对话式迭代修改,保留版本历史
- 一键发布,公开链接 `/s/<slug>`;CSP sandbox 隔离生成的 JS 与主站凭证
- 项目列表(状态/删除/继续编辑)、积分余额

## 架构(极简:Worker + D1 + Assets)

```
浏览器 ──► Cloudflare Worker (单入口, Hono)
             ├── 静态资源: Workers Assets (前端 SPA, Vite + React + Tailwind)
             ├── /api/*   : auth / projects / generate(SSE) / publish
             ├── /s/:slug : 发布的用户站点(从 D1 读 HTML 返回)
             └── D1 (SQLite): 唯一持久层(users/sessions/projects/versions/messages)
```

关键取舍:

- 生成产物为单 HTML 文件(几十 KB),直接存 D1 TEXT 列,不引入 R2/KV/Queues/DO
- LLM 用 OpenAI 兼容接口(环境变量 `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`),原生 fetch,可接 OpenAI/DeepSeek/GLM/OpenRouter 等
- 发布用路径而非子域名,免 wildcard 证书;`/s/:slug` 加 `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups`,生成的 JS 运行在 opaque origin,读不到主站 cookie/localStorage
- 前端依赖仅 react + react-router-dom + vite + tailwindcss;Worker 端仅 hono

## 本地开发

```bash
npm install && npm --prefix web install
npx wrangler d1 execute DB --local --file=schema.sql   # 初始化本地库
cp .dev.vars.example .dev.vars                          # 填入任一 OpenAI 兼容 key
npm run dev        # 终端 A:wrangler dev,http://localhost:8787
npm run dev:web    # 终端 B:vite dev,http://localhost:5173(/api 代理到 8787)
```

浏览器访问 http://localhost:5173:注册 → 首页输入想法 → 工作台看规划卡片与流式生成 → 追加对话修改 → 发布后访问 `localhost:8787/s/<slug>` 验证。

## 部署

```bash
npx wrangler d1 create forge            # 把输出的 database_id 填入 wrangler.jsonc
npm run db:init:remote                  # 初始化远程 D1
npx wrangler secret put LLM_BASE_URL    # 依次配置三个 secrets
npx wrangler secret put LLM_API_KEY
npx wrangler secret put LLM_MODEL
npm run deploy                          # 构建前端并部署 Worker
```

部署后重复本地第 4 步的公开链接验证。

## SSE 协议

`POST /api/projects/:id/generate | chat` 返回 `text/event-stream`,`data:` 行依次为:

```
{"type":"plan","data":{"name":"…","tagline":"…","palette":["#…"],"sections":[{"title":"…","summary":"…"}]}}
{"type":"thinking","delta":"…"}            // 可选,思维链增量(思考型模型如 GLM 5.x 才有)
{"type":"code","delta":"…"}                // 多条增量
{"type":"done","version":3,"html":"…","credits":18}
{"type":"error","message":"…"}
```

> 思考型模型默认思维链较长,生成前会有一段「思考中」阶段;可通过 `LLM_THINKING`(JSON,原样透传,如 `{"type":"enabled","effort":"low"}`)调节,LLM 网关偶发瞬时 401/5xx 已内置一次自动重试。

## 升级路径(当前明确不做)

- 子域名发布(`slug.example.com`,需 wildcard 证书/自定义域)或 Workers for Platforms 多租户
- Workers AI 内置模型,免去外部 key
- 多智能体编排、可视化编辑器、Stripe 支付、广告投放、SEO 自动化
- 代码导出 GitHub、图片上传、团队协作
- 生成产物从 D1 迁移到 R2 + KV 缓存,发布走 Queues 异步
