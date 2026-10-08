import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv, ProjectRow } from '../types'
import { requireUser } from '../lib/auth'
import { assertCredits, activeJobSnapshot, insertMessage, resumableJobSnapshot } from '../lib/jobHelpers'
import { type JobType, createJob } from '../lib/jobs'

const app = new Hono<AppEnv>()
app.use('*', requireUser)

async function ownedProject(c: Context<AppEnv>, id: string): Promise<ProjectRow | null> {
  return c.env.DB.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').bind(id, c.get('user').id).first<ProjectRow>()
}

/**
 * 建任务 + 落用户消息 + 启动工作流实例,返回 {jobId} 或 409。
 * 两处补偿删除:用户消息或实例创建失败时删掉刚建的任务再抛错,
 * 避免孤儿任务把项目 409 锁死、或被巡检误判后凭空生成
 */
async function launchJob(
  c: Context<AppEnv>,
  project: ProjectRow,
  type: JobType,
  payload: Record<string, string>,
  userText: string
) {
  const jobId = await createJob(c.env.DB, project.id, c.get('user').id, type, payload)
  if (!jobId) return c.json({ error: '该项目已有生成任务在进行中,请稍候' }, 409)
  try {
    await insertMessage(c.env.DB, project.id, 'user', userText)
  } catch (err) {
    await c.env.DB.prepare(`DELETE FROM jobs WHERE id = ? AND status = 'pending'`).bind(jobId).run().catch(() => {})
    throw err
  }
  try {
    // instance id 即 jobId:巡检按行找实例、前端按 jobId 轮询,三方同一标识
    await c.env.GENERATION.create({ id: jobId, params: { jobId } })
  } catch (err) {
    await c.env.DB.prepare(`DELETE FROM jobs WHERE id = ? AND status = 'pending'`).bind(jobId).run().catch(() => {})
    throw err
  }
  return c.json({ jobId })
}

/**
 * 首次生成(或按想法重新生成):校验通过后落一条用户消息 + 建后台任务,立即返回 jobId。
 * 实际 LLM 生成在 waitUntil 中异步执行,与客户端连接解耦;前端轮询任务状态。
 */
app.post('/:id/generate', async (c) => {
  const user = c.get('user')
  const project = await ownedProject(c, c.req.param('id'))
  if (!project) return c.json({ error: '项目不存在' }, 404)

  const body = await c.req.json<{ idea?: string; note?: string }>().catch(() => ({}) as { idea?: string; note?: string })
  const idea = String(body.idea ?? '').trim()
  if (!idea) return c.json({ error: '想法不能为空' }, 400)
  // note:失败后续聊的补充要求(如「重试定价方案」),随工作流注入各段生成,不参与断点复用的匹配
  const note = String(body.note ?? '').trim()
  if (!(await assertCredits(c.env.DB, user.id))) return c.json({ error: '积分不足,无法生成' }, 402)

  return launchJob(c, project, 'generate', note ? { idea, note } : { idea }, idea)
})

/** 对话式迭代修改:同样走后台任务 */
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
  if (!(await assertCredits(c.env.DB, user.id))) return c.json({ error: '积分不足,无法生成' }, 402)

  return launchJob(c, project, 'chat', { message }, message)
})

/** 断线/刷新恢复:活动任务(接管轮询)+ 可续任务(失败但有产物,继续对话即续跑) */
app.get('/:id/job/active', async (c) => {
  const [job, resume] = await Promise.all([
    activeJobSnapshot(c.env.DB, c.req.param('id'), c.get('user').id),
    resumableJobSnapshot(c.env.DB, c.req.param('id'), c.get('user').id),
  ])
  return c.json({ job, resume })
})

export const generateRoutes = app
