# 前后端整套方案:Cloudflare 作为 BaaS(v1)

## 目标与边界

生成的页面获得真实后端能力:访问者提交的数据能存下来(留言板/报名表/点赞/计数器等),平台提供数据接口,Cloudflare Workers + D1 承载。

**v1 范围**:通用数据集合 API(公开读/写)+ 项目主人的数据管理界面。
**不做**:访客登录体系、多页面站、每租户独立 Worker(后续版本)。

## 核心设计

### 1. 数据模型(schema.sql 追加,IF NOT EXISTS 幂等)

```sql
CREATE TABLE IF NOT EXISTS site_data (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  collection  TEXT NOT NULL,   -- 集合名,生成代码里约定,如 guestbook / signups
  data        TEXT NOT NULL,   -- 任意 JSON
  client_ip   TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_site_data_lookup ON site_data(project_id, collection, created_at);
```

### 2. 公开站点 API(src/routes/site.ts,新文件)

路径按 slug 命名空间,与页面托管分离:

- `GET /api/site/:slug/:collection` → `{items:[{id,data,created_at}]}` 最新 100 条
- `POST /api/site/:slug/:collection` body 为任意 JSON → `{id}`

约束:
- 集合名 `/^[a-z][a-z0-9_-]{0,31}$/`;body ≤ 4KB
- 每项目每集合上限 500 行(409 数据已满)
- 限流:同 IP 对同项目每 60s 最多 10 次写入(D1 COUNT 实现,429)
- CORS:页面运行在 CSP sandbox 的 opaque origin(Origin: null),需 `Access-Control-Allow-Origin: *` + OPTIONS 预检 204;接口完全不碰 session cookie,与主站鉴权天然隔离
- client_ip 取 `CF-Connecting-IP`,仅用于限流

### 3. 代码占位符注入(关键机制)

生成/存储的 HTML 里统一用占位符 `__FORGE_API__`,只在渲染边界替换:
- 发布页 `src/index.ts` `/s/:slug`:`row.html.replaceAll('__FORGE_API__', '/api/site/' + slug)`(相对路径,天然兼容将来自定义域名)
- 编辑器预览 `PreviewPane.tsx`:替换为 `${location.origin}/api/site/${project.slug}`(srcDoc iframe 内指向宿主 origin)

存储的版本始终保留占位符 → origin 无关,迁移域名不用重写历史版本。

### 4. 提示词更新(src/lib/prompts.ts)

- `codeMessages` 增加第 8 条:何时用数据接口(需要保存访问者提交的数据时)、怎么调(fetch + JSON,读取渲染、失败兜底)、禁止收集敏感信息、纯展示页不要调用
- `reviseMessages` 增加一条:修改时保持 `__FORGE_API__` 调用方式不变

### 5. 数据管理 API(src/routes/projects.ts 追加,走现有鉴权中间件)

- `GET /api/projects/:id/data` → 各集合及行数
- `GET /api/projects/:id/data/:collection` → 最新 200 行
- `DELETE /api/projects/:id/data/:collection/:rowId` → 删单行
- `DELETE /api/projects/:id/data/:collection` → 清空集合

### 6. 数据管理 UI(web/src/components/DataPanel.tsx,新文件)

PreviewPane 顶部标签从「预览/代码」扩为「预览/代码/数据」:
- 数据面板:集合列表(行数)→ 点开看行(JSON 可读展示)→ 删除单行/清空集合,操作前确认
- 空态文案:「页面调用平台数据接口后,访问者提交的数据会出现在这里」

## 实施顺序

1. schema.sql 追加表,本地 + 远程各执行一次(idempotent)
2. `src/routes/site.ts` 公开 API + `src/index.ts` 挂载 + `/s/:slug` 占位符替换
3. `src/routes/projects.ts` 数据管理 API
4. `src/lib/prompts.ts` 提示词
5. 前端:PreviewPane 数据标签 + DataPanel + 占位符替换 + types
6. `npm run typecheck`
7. 本地验证:
   - 纯 API 链路(不依赖 LLM):POST/GET/限流(连发 11 次→429)/行数上限、owner 列表/删除
   - LLM 链路:用「访客留言板」想法真实生成一次,验证生成代码确实调用数据接口,页面提交 → 数据落库 → owner 面板可见可删
8. 生产部署(当前网络对 Cloudflare API 阻断,若仍不通则本地完成、待网络恢复后 `npm run deploy`)+ 远程 schema 应用 + 线上冒烟

## 风险与对策

- **滥用免费存储**:行数/大小/限流三重上限;数据与项目绑定可整体清理
- **LLM 不按提示词调用**:解析层不强依赖(接口容错),生成结果里检查占位符是否存在,不达标可重试生成(已有积分机制兜底)
- **CORS 过宽(ACAO *)**:接口本就是公开读写语义,不涉及凭证;写操作限流兜底
