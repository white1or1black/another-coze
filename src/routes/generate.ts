import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv, ProjectRow } from '../types'
import { requireUser } from '../lib/auth'
import { chatOnce } from '../lib/llm'
import { codeMessages, extractHtml, parsePlan, planMessages, reviseMessages } from '../lib/prompts'
import { deductCredit } from '../lib/credits'

const app = new Hono<AppEnv>()
app.use('*', requireUser)

type Send = (event: unknown) => void

/**
 * 把 handler 的产出包装为 text/event-stream 响应。
 * - 空窗期每 10s 发一次 progress 事件(携带已用秒数):让前端确认连接存活并展示进度
 * - 监听客户端断开(signal abort):及时中止,避免用户没看到结果却被写库扣积分
 */
function sseResponse(signal: AbortSignal, handler: (send: Send) => Promise<void>): Response {
  const encoder = new TextEncoder()
  const startedAt = Date.now()
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false
      const send: Send = (event) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        } catch {
          closed = true
        }
      }
      signal.addEventListener('abort', () => {
        closed = true
        try {
          controller.close()
        } catch {
          // 已关闭
        }
      })
      const progress = setInterval(() => {
        send({ type: 'progress', elapsed: Math.round((Date.now() - startedAt) / 1000) })
      }, 10_000)
      try {
        await handler(send)
      } catch (err) {
        send({ type: 'error', message: err instanceof Error ? err.message : '生成失败,请重试' })
      } finally {
        clearInterval(progress)
        closed = true
        try {
          controller.close()
        } catch {
          // 客户端已断开,无需处理
        }
      }
    },
  })
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
    },
  })
}

async function ownedProject(c: Context<AppEnv>, id: string): Promise<ProjectRow | null> {
  return c.env.DB
    .prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?')
    .bind(id, c.get('user').id)
    .first<ProjectRow>()
}

async function assertCredits(c: Context<AppEnv>): Promise<boolean> {
  const row = await c.env.DB
    .prepare('SELECT credits FROM users WHERE id = ?')
    .bind(c.get('user').id)
    .first<{ credits: number }>()
  return !!row && row.credits >= 1
}

async function insertMessage(c: Context<AppEnv>, projectId: string, role: 'user' | 'assistant', content: string) {
  await c.env.DB
    .prepare('INSERT INTO messages (id, project_id, role, content) VALUES (?, ?, ?, ?)')
    .bind(crypto.randomUUID(), projectId, role, content)
    .run()
}

/** 首次生成(或按想法重新生成):先推 plan 事件,再整页生成 */
app.post('/:id/generate', async (c) => {
  const user = c.get('user')
  const project = await ownedProject(c, c.req.param('id'))
  if (!project) return c.json({ error: '项目不存在' }, 404)

  const body = await c.req.json<{ idea?: string }>().catch(() => ({}) as { idea?: string })
  const idea = String(body.idea ?? '').trim()
  if (!idea) return c.json({ error: '想法不能为空' }, 400)
  if (!(await assertCredits(c))) return c.json({ error: '积分不足,无法生成' }, 402)

  await insertMessage(c, project.id, 'user', idea)

  return sseResponse(c.req.raw.signal, async (send) => {
    // 阶段 1:规划
    const plan = parsePlan(await chatOnce(c.env, planMessages(idea)), idea)
    send({ type: 'plan', data: plan })

    // 阶段 2:整页生成。Free 套餐 10ms CPU 配额撑不住 token 级流式转发(实测约 3.6K 行上游数据即超限被强杀),故一次性取回结果
    const html = extractHtml(await chatOnce(c.env, codeMessages(idea, plan)))
    // 用户等不到结果已离开:到此为止,不写版本也不扣积分
    if (c.req.raw.signal.aborted) throw new Error('客户端已断开')
    if (!html.includes('<')) throw new Error('模型未返回有效页面,请重试')

    const version = project.current_version + 1
    await c.env.DB.batch([
      c.env.DB
        .prepare('INSERT INTO versions (id, project_id, version_no, html, prompt) VALUES (?, ?, ?, ?, ?)')
        .bind(crypto.randomUUID(), project.id, version, html, idea),
      c.env.DB
        .prepare("UPDATE projects SET name = ?, description = ?, current_version = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(plan.name, plan.tagline, version, project.id),
    ])
    await insertMessage(c, project.id, 'assistant', `已完成「${plan.name}」初版生成(v${version})`)

    const credits = (await deductCredit(c.env.DB, user.id)) ?? user.credits
    send({ type: 'done', version, html, credits })
  })
})

/** 对话式迭代修改:基于当前版本全量重写 */
app.post('/:id/chat', async (c) => {
  const user = c.get('user')
  const project = await ownedProject(c, c.req.param('id'))
  if (!project) return c.json({ error: '项目不存在' }, 404)

  const body = await c.req.json<{ message?: string }>().catch(() => ({}) as { message?: string })
  const message = String(body.message ?? '').trim()
  if (!message) return c.json({ error: '内容不能为空' }, 400)

  const current = await c.env.DB
    .prepare('SELECT html FROM versions WHERE project_id = ? ORDER BY version_no DESC LIMIT 1')
    .bind(project.id)
    .first<{ html: string }>()
  if (!current) return c.json({ error: '请先生成页面,再进行修改' }, 400)
  if (!(await assertCredits(c))) return c.json({ error: '积分不足,无法生成' }, 402)

  await insertMessage(c, project.id, 'user', message)

  return sseResponse(c.req.raw.signal, async (send) => {
    // 同 generate:Free 套餐 CPU 配额不允许 token 级流式转发,整页一次取回
    const html = extractHtml(await chatOnce(c.env, reviseMessages(current.html, message)))
    // 用户等不到结果已离开:到此为止,不写版本也不扣积分
    if (c.req.raw.signal.aborted) throw new Error('客户端已断开')
    if (!html.includes('<')) throw new Error('模型未返回有效页面,请重试')

    const version = project.current_version + 1
    await c.env.DB.batch([
      c.env.DB
        .prepare('INSERT INTO versions (id, project_id, version_no, html, prompt) VALUES (?, ?, ?, ?, ?)')
        .bind(crypto.randomUUID(), project.id, version, html, message),
      c.env.DB
        .prepare("UPDATE projects SET current_version = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(version, project.id),
    ])
    await insertMessage(c, project.id, 'assistant', `已按「${message.slice(0, 30)}」更新至 v${version}`)

    const credits = (await deductCredit(c.env.DB, user.id)) ?? user.credits
    send({ type: 'done', version, html, credits })
  })
})

export const generateRoutes = app
