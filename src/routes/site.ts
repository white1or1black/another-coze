import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../types'

/**
 * 公开站点数据 API:生成页面通过它存取访问者提交的数据(Cloudflare BaaS 存储层)。
 * 页面运行在 CSP sandbox 的 opaque origin(Origin: null),故响应必须带 ACAO:*;
 * 接口不读 session cookie,与主站鉴权完全隔离,滥用靠大小/行数/限流三重上限约束。
 */

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

const MAX_BODY_BYTES = 4096
const MAX_ROWS_PER_COLLECTION = 500
const RATE_LIMIT_WRITES = 10
const RATE_LIMIT_WINDOW_SQL = "created_at > datetime('now', '-60 seconds')"

const SLUG_RE = /^[a-z0-9]{4,16}$/
const COLLECTION_RE = /^[a-z][a-z0-9_-]{0,31}$/

function cors(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: CORS_HEADERS })
}

const app = new Hono<AppEnv>()

app.options('/:slug/:collection', (c) => new Response(null, { status: 204, headers: CORS_HEADERS }))

async function projectBySlug(c: Context<AppEnv>, slug: string): Promise<{ id: string } | null> {
  return c.env.DB.prepare('SELECT id FROM projects WHERE slug = ?').bind(slug).first<{ id: string }>()
}

/** 读取集合:最新 100 条,新在前 */
app.get('/:slug/:collection', async (c) => {
  const slug = c.req.param('slug')
  const collection = c.req.param('collection')
  if (!SLUG_RE.test(slug) || !COLLECTION_RE.test(collection)) return cors({ error: '参数不合法' }, 400)

  const project = await projectBySlug(c, slug)
  if (!project) return cors({ error: '站点不存在' }, 404)

  const { results } = await c.env.DB
    .prepare('SELECT id, data, created_at FROM site_data WHERE project_id = ? AND collection = ? ORDER BY rowid DESC LIMIT 100')
    .bind(project.id, collection)
    .all<{ id: string; data: string; created_at: string }>()

  const items = results.map((r) => {
    let data: unknown = {}
    try {
      data = JSON.parse(r.data)
    } catch {
      // 理论不会发生(写入前已 stringify),兜底空对象
    }
    return { id: r.id, data, created_at: r.created_at }
  })
  return cors({ items })
})

/** 写入集合:任意 JSON 对象,受大小/行数/频率三重上限约束 */
app.post('/:slug/:collection', async (c) => {
  const slug = c.req.param('slug')
  const collection = c.req.param('collection')
  if (!SLUG_RE.test(slug) || !COLLECTION_RE.test(collection)) return cors({ error: '参数不合法' }, 400)

  const project = await projectBySlug(c, slug)
  if (!project) return cors({ error: '站点不存在' }, 404)

  const raw = await c.req.text()
  if (raw.length > MAX_BODY_BYTES) return cors({ error: '提交内容过大' }, 413)
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return cors({ error: '请求体必须是 JSON' }, 400)
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return cors({ error: '提交内容必须是 JSON 对象' }, 400)
  }

  const ip = c.req.header('CF-Connecting-IP') ?? ''
  const limited = await c.env.DB
    .prepare(`SELECT COUNT(*) AS n FROM site_data WHERE project_id = ? AND client_ip = ? AND ${RATE_LIMIT_WINDOW_SQL}`)
    .bind(project.id, ip)
    .first<{ n: number }>()
  if ((limited?.n ?? 0) >= RATE_LIMIT_WRITES) return cors({ error: '提交太频繁,请稍后再试' }, 429)

  const total = await c.env.DB
    .prepare('SELECT COUNT(*) AS n FROM site_data WHERE project_id = ? AND collection = ?')
    .bind(project.id, collection)
    .first<{ n: number }>()
  if ((total?.n ?? 0) >= MAX_ROWS_PER_COLLECTION) return cors({ error: '该站点数据已满' }, 409)

  const id = crypto.randomUUID()
  await c.env.DB
    .prepare('INSERT INTO site_data (id, project_id, collection, data, client_ip) VALUES (?, ?, ?, ?, ?)')
    .bind(id, project.id, collection, JSON.stringify(body), ip)
    .run()
  return cors({ id }, 201)
})

export const siteRoutes = app
