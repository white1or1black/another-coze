import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { AppEnv } from '../types'
import { requireUser } from '../lib/auth'
import { jobSnapshot } from '../lib/jobHelpers'

/** 任务状态轮询:仅任务属主可查 */
const app = new Hono<AppEnv>()
app.use('*', requireUser)

app.get('/:id', async (c) => {
  const job = await jobSnapshot(c.env.DB, c.req.param('id'), c.get('user').id)
  if (!job) return c.json({ error: '任务不存在' }, 404)
  return c.json({ job })
})

/**
 * 任务进度订阅(SSE)。任务执行体在别的隔离实例里跑,这里只是把 D1 里的状态变化推给浏览器:
 * - 状态有变化才推送(status/stage/plan/version/error),空闲期每 15s 发一次心跳(携带最新 elapsed)
 * - 到达终态后发送最终快照并主动关闭;连接断开不影响后台任务
 * 客户端 EventSource onerror 时自动降级为轮询(见 api.ts subscribeJob)
 */
app.get('/:id/events', async (c) => {
  const id = c.req.param('id')
  const userId = c.get('user').id
  if (!(await jobSnapshot(c.env.DB, id, userId))) return c.json({ error: '任务不存在' }, 404)

  return streamSSE(c, async (stream) => {
    let last = ''
    let lastSentAt = 0
    try {
      for (;;) {
        const snap = await jobSnapshot(c.env.DB, id, userId)
        if (!snap) break
        const fp = JSON.stringify([snap.status, snap.stage, snap.plan, snap.error, snap.version])
        const now = Date.now()
        if (fp !== last || now - lastSentAt > 15_000) {
          last = fp
          lastSentAt = now
          await stream.writeSSE({ data: JSON.stringify(snap) })
        }
        if (snap.status === 'succeeded' || snap.status === 'failed') break
        if (stream.aborted) break
        await stream.sleep(1500)
      }
    } catch {
      // 客户端已断开(writeSSE 抛错),收尾即可
    }
  })
})

export const jobRoutes = app
