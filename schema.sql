CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  credits       INTEGER NOT NULL DEFAULT 20,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  slug            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL DEFAULT '',
  description     TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'draft',
  current_version INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS versions (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  version_no INTEGER NOT NULL,
  html       TEXT NOT NULL,
  prompt     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, version_no)
);

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 后台生成任务:请求只负责建任务并立刻返回,实际 LLM 生成在 waitUntil / cron 中异步执行,
-- 前端轮询任务状态,刷新页面、断网都不丢任务
CREATE TABLE IF NOT EXISTS jobs (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id),
  user_id        TEXT NOT NULL REFERENCES users(id),
  type           TEXT NOT NULL,             -- 'generate' | 'chat'
  payload        TEXT NOT NULL,             -- JSON:{idea} 或 {message}
  status         TEXT NOT NULL DEFAULT 'pending',  -- pending | running | succeeded | failed
  stage          TEXT NOT NULL DEFAULT 'planning', -- planning | coding
  progress       TEXT,                      -- 人读的分段进度(工作流各 step 写入,如「正在生成章节 2/4」)
  plan_json      TEXT,
  html_preview   TEXT,                      -- 生成中的半成品页面(骨架+已完成计划项),前端实时预览
  error          TEXT,
  result_version INTEGER,
  started_at     TEXT,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))  -- 任务总龄的计时起点(cron 据此永久判死反复中断的任务)
);

-- 站点运行数据:生成页面通过 /api/site/:slug/:env/:collection 读写,Cloudflare BaaS 的存储层
-- env = 'draft'(编辑器预览产生) / 'live'(发布后访客产生),两套数据互不可见
CREATE TABLE IF NOT EXISTS site_data (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  env         TEXT NOT NULL DEFAULT 'live',
  collection  TEXT NOT NULL,
  data        TEXT NOT NULL,
  client_ip   TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_projects_user    ON projects(user_id);
CREATE INDEX IF NOT EXISTS idx_versions_project ON versions(project_id);
CREATE INDEX IF NOT EXISTS idx_messages_project ON messages(project_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_site_data_lookup ON site_data(project_id, collection, created_at);

CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id, status);
CREATE INDEX IF NOT EXISTS idx_jobs_user    ON jobs(user_id, status);
-- cron 每分钟按 status + updated_at 清扫,走此索引避免全表扫描
CREATE INDEX IF NOT EXISTS idx_jobs_sweep   ON jobs(status, updated_at);
