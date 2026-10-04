import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv, ProjectRow } from '../types'
import { requireUser } from '../lib/auth'

const app = new Hono<AppEnv>()
app.use('*', requireUser)

function randomSlug(len = 8): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = crypto.getRandomValues(new Uint8Array(len))
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')
}

async function newUniqueSlug(db: D1Database): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const slug = randomSlug()
    const hit = await db.prepare('SELECT id FROM projects WHERE slug = ?').bind(slug).first()
    if (!hit) return slug
  }
  return randomSlug(12)
}

async function ownedProject(c: Context<AppEnv>, id: string): Promise<ProjectRow | null> {
  return c.env.DB
    .prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?')
    .bind(id, c.get('user').id)
    .first<ProjectRow>()
}

/** 项目列表 */
app.get('/', async (c) => {
  const { results } = await c.env.DB
    .prepare(
      `SELECT id, slug, name, description, status, current_version, created_at, updated_at
       FROM projects WHERE user_id = ? ORDER BY updated_at DESC`
    )
    .bind(c.get('user').id)
    .all()
  return c.json({ projects: results })
})

/** 创建项目(带初始想法) */
app.post('/', async (c) => {
  const body = await c.req.json<{ idea?: string }>().catch(() => ({}) as { idea?: string })
  const idea = String(body.idea ?? '').trim()
  if (!idea) return c.json({ error: '想法不能为空' }, 400)

  const id = crypto.randomUUID()
  const slug = await newUniqueSlug(c.env.DB)
  await c.env.DB
    .prepare("INSERT INTO projects (id, user_id, slug, name) VALUES (?, ?, ?, ?)")
    .bind(id, c.get('user').id, slug, idea.slice(0, 30))
    .run()
  return c.json({ id })
})

/** 项目详情:项目 + 消息历史 + 当前版本 HTML */
app.get('/:id', async (c) => {
  const project = await ownedProject(c, c.req.param('id'))
  if (!project) return c.json({ error: '项目不存在' }, 404)

  const { results: messages } = await c.env.DB
    .prepare('SELECT id, role, content, created_at FROM messages WHERE project_id = ? ORDER BY rowid')
    .bind(project.id)
    .all()

  let html: string | null = null
  if (project.current_version > 0) {
    const v = await c.env.DB
      .prepare('SELECT html FROM versions WHERE project_id = ? AND version_no = ?')
      .bind(project.id, project.current_version)
      .first<{ html: string }>()
    html = v?.html ?? null
  }
  return c.json({ project, messages, html })
})

app.delete('/:id', async (c) => {
  const project = await ownedProject(c, c.req.param('id'))
  if (!project) return c.json({ error: '项目不存在' }, 404)
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM messages WHERE project_id = ?').bind(project.id),
    c.env.DB.prepare('DELETE FROM versions WHERE project_id = ?').bind(project.id),
    c.env.DB.prepare('DELETE FROM site_data WHERE project_id = ?').bind(project.id),
    c.env.DB.prepare('DELETE FROM projects WHERE id = ?').bind(project.id),
  ])
  return c.json({ ok: true })
})

app.post('/:id/publish', async (c) => {
  const project = await ownedProject(c, c.req.param('id'))
  if (!project) return c.json({ error: '项目不存在' }, 404)
  if (project.current_version === 0) return c.json({ error: '请先生成页面再发布' }, 400)
  await c.env.DB
    .prepare("UPDATE projects SET status = 'published', updated_at = datetime('now') WHERE id = ?")
    .bind(project.id)
    .run()
  const url = new URL(`/s/${project.slug}`, c.req.url).toString()
  return c.json({ slug: project.slug, url })
})

// ---------- 站点数据管理:查看/清理生成页面收集的访问者数据(草稿/线上两个环境) ----------

const DATA_ENV_RE = /^(draft|live)$/

/** 各数据集合及行数(按环境分组) */
app.get('/:id/data', async (c) => {
  const project = await ownedProject(c, c.req.param('id'))
  if (!project) return c.json({ error: '项目不存在' }, 404)
  const { results } = await c.env.DB
    .prepare(
      'SELECT env, collection, COUNT(*) AS count FROM site_data WHERE project_id = ? GROUP BY env, collection ORDER BY env, collection'
    )
    .bind(project.id)
    .all<{ env: string; collection: string; count: number }>()
  return c.json({ collections: results })
})

/** 某环境下某集合的行(最新 200 条) */
app.get('/:id/data/:env/:collection', async (c) => {
  const project = await ownedProject(c, c.req.param('id'))
  if (!project) return c.json({ error: '项目不存在' }, 404)
  const env = c.req.param('env')
  if (!DATA_ENV_RE.test(env)) return c.json({ error: '参数不合法' }, 400)
  const { results } = await c.env.DB
    .prepare(
      'SELECT id, data, created_at FROM site_data WHERE project_id = ? AND env = ? AND collection = ? ORDER BY rowid DESC LIMIT 200'
    )
    .bind(project.id, env, c.req.param('collection'))
    .all<{ id: string; data: string; created_at: string }>()
  return c.json({
    items: results.map((r) => {
      let data: unknown = {}
      try {
        data = JSON.parse(r.data)
      } catch {
        // 兜底空对象
      }
      return { id: r.id, data, created_at: r.created_at }
    }),
  })
})

/** 清空某环境下的集合 */
app.delete('/:id/data/:env/:collection', async (c) => {
  const project = await ownedProject(c, c.req.param('id'))
  if (!project) return c.json({ error: '项目不存在' }, 404)
  const env = c.req.param('env')
  if (!DATA_ENV_RE.test(env)) return c.json({ error: '参数不合法' }, 400)
  await c.env.DB
    .prepare('DELETE FROM site_data WHERE project_id = ? AND env = ? AND collection = ?')
    .bind(project.id, env, c.req.param('collection'))
    .run()
  return c.json({ ok: true })
})

/** 删除单行 */
app.delete('/:id/data/:env/:collection/:rowId', async (c) => {
  const project = await ownedProject(c, c.req.param('id'))
  if (!project) return c.json({ error: '项目不存在' }, 404)
  const env = c.req.param('env')
  if (!DATA_ENV_RE.test(env)) return c.json({ error: '参数不合法' }, 400)
  await c.env.DB
    .prepare('DELETE FROM site_data WHERE id = ? AND project_id = ? AND env = ? AND collection = ?')
    .bind(c.req.param('rowId'), project.id, env, c.req.param('collection'))
    .run()
  return c.json({ ok: true })
})

export const projectRoutes = app
