import type { Env } from '../types'
import { ACTIVE_STATUS_SQL } from './jobHelpers'

export type JobType = 'generate' | 'chat'
export type JobStatus = 'pending' | 'running' | 'succeeded' | 'failed'

/** 任务创建后超过多久仍未结局则判死兜底,解锁项目(正常由工作流引擎推进,不应触达) */
const JOB_MAX_SECONDS = 1800

/** 创建任务。同一项目同时只允许一个未完成任务:单条条件 INSERT 原子判定,无 check-then-insert 竞态 */
export async function createJob(
  db: Env['DB'],
  projectId: string,
  userId: string,
  type: JobType,
  payload: Record<string, string>
): Promise<string | null> {
  const id = crypto.randomUUID()
  const result = await db
    .prepare(
      `INSERT INTO jobs (id, project_id, user_id, type, payload)
       SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (
         SELECT 1 FROM jobs WHERE project_id = ? AND ${ACTIVE_STATUS_SQL}
       )`
    )
    .bind(id, projectId, userId, type, JSON.stringify(payload), projectId)
    .run()
  return result.meta.changes ? id : null
}

async function failJob(db: Env['DB'], id: string, message: string) {
  await db
    .prepare(`UPDATE jobs SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ? AND ${ACTIVE_STATUS_SQL}`)
    .bind(message.slice(0, 300), id)
    .run()
    .catch(() => {})
}

/**
 * cron 巡检兜底。正常推进完全由工作流引擎负责(step checkpoint + 自动重试 + 断点恢复),
 * 这里只处理引擎之外的不一致:实例已 errored/丢失但任务行仍活动(否则项目被 409 锁死),
 * 以及超过总龄上限的僵死任务。
 */
export async function sweepJobs(env: Env): Promise<void> {
  const db = env.DB
  const active = await db
    .prepare(`SELECT id FROM jobs WHERE ${ACTIVE_STATUS_SQL}`)
    .all<{ id: string }>()
  for (const row of active.results ?? []) {
    try {
      const instance = await env.GENERATION.get(row.id)
      const status = await instance.status()
      if (status.status === 'errored') {
        const err = (status as { error?: { message?: string } }).error?.message
        await failJob(db, row.id, `生成中断:${err ?? '工作流执行失败,请重试(未扣除积分)'}`)
      } else if (status.status === 'complete') {
        // 理论不可达(finalize 先于 complete);防御性判死避免永久锁项目
        await failJob(db, row.id, '任务异常结束,请重试(未扣除积分)')
      }
    } catch {
      // 实例不存在(创建失败残留等)
      await failJob(db, row.id, '任务执行体丢失,请重试(未扣除积分)')
    }
  }
  await db
    .prepare(
      `UPDATE jobs SET status = 'failed', error = '任务超时未完成,请重新发起(未扣除积分)', updated_at = datetime('now')
       WHERE ${ACTIVE_STATUS_SQL} AND created_at < datetime('now', '-${JOB_MAX_SECONDS} seconds')`
    )
    .run()
}
