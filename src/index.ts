import { Hono } from 'hono'
import type { Env } from './types'
import { authRoutes } from './routes/auth'
import { projectRoutes } from './routes/projects'
import { generateRoutes } from './routes/generate'
import { siteRoutes } from './routes/site'

const app = new Hono<{ Bindings: Env }>()

app.route('/api/auth', authRoutes)
app.route('/api/projects', projectRoutes)
app.route('/api/projects', generateRoutes)
app.route('/api/site', siteRoutes)

/** 公开发布页:/s/:slug,从 D1 读当前版本 HTML;CSP sandbox 使其运行在 opaque origin,无法读取主站凭证 */
app.get('/s/:slug', async (c) => {
  const row = await c.env.DB
    .prepare(
      `SELECT v.html FROM projects p
       JOIN versions v ON v.project_id = p.id AND v.version_no = p.current_version
       WHERE p.slug = ? AND p.status = 'published'`
    )
    .bind(c.req.param('slug'))
    .first<{ html: string }>()
  if (!row) return c.text('404 Not Found', 404)
  // 页面里的 __FORGE_API__ 是站点数据接口占位符;相对路径跟随当前域名,存储的 HTML 保持 origin 无关
  const html = row.html.split('__FORGE_API__').join(`/api/site/${c.req.param('slug')}`)
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': 'sandbox allow-scripts allow-forms allow-popups',
      'X-Content-Type-Options': 'nosniff',
    },
  })
})

/** 其余路径交给前端 SPA(assets 已直接命中静态文件,这里兜底 index.html);未命中的 /api/* 返回 JSON 404 */
app.get('*', async (c) => {
  if (c.req.path.startsWith('/api/')) return c.json({ error: '接口不存在' }, 404)
  return c.env.ASSETS.fetch(new Request(new URL('/', c.req.url)))
})

app.onError((err, c) => {
  console.error(err)
  return c.json({ error: '服务器内部错误' }, 500)
})

export default app
