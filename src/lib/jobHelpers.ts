/** 与任务相关的公共小工具(供 generate 路由与 jobs 执行体共用) */

/** 未完成任务判定:任务创建互斥与断线恢复共用同一语义 */
export const ACTIVE_STATUS_SQL = "status IN ('pending','running')"

export async function assertCredits(db: D1Database, userId: string): Promise<boolean> {
  const row = await db.prepare('SELECT credits FROM users WHERE id = ?').bind(userId).first<{ credits: number }>()
  return !!row && row.credits >= 1
}

export async function insertMessage(
  db: D1Database,
  projectId: string,
  role: 'user' | 'assistant',
  content: string
) {
  await db
    .prepare('INSERT INTO messages (id, project_id, role, content) VALUES (?, ?, ?, ?)')
    .bind(crypto.randomUUID(), projectId, role, content)
    .run()
}

const SNAPSHOT_COLUMNS = 'id, user_id, type, status, stage, progress, plan_json, error, result_version, started_at'

interface SnapshotRow {
  id: string
  user_id: string
  type: 'generate' | 'chat'
  status: string
  stage: string
  progress: string | null
  plan_json: string | null
  error: string | null
  result_version: number | null
  started_at: string | null
}

function snapshotFromRow(row: SnapshotRow) {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    stage: row.stage,
    progress: row.progress,
    plan: row.plan_json ? (JSON.parse(row.plan_json) as unknown) : null,
    error: row.error,
    version: row.result_version,
    // D1 datetime('now') 是空格分隔的非 ISO 格式,转成 'T' 再解析,避免依赖 V8 的宽松扩展
    elapsed: row.started_at
      ? Math.max(0, Math.floor((Date.now() - Date.parse(row.started_at.replace(' ', 'T') + 'Z')) / 1000))
      : 0,
  }
}

/** 任务状态快照(轮询/SSE 响应体):只暴露前端需要的字段,elapsed 由服务端计算;
 *  传入 userId 时同时校验属主,非属主与不存在一样返回 null */
export async function jobSnapshot(db: D1Database, jobId: string, userId?: string) {
  const row = await db
    .prepare(`SELECT ${SNAPSHOT_COLUMNS} FROM jobs WHERE id = ?`)
    .bind(jobId)
    .first<SnapshotRow>()
  if (!row || (userId !== undefined && row.user_id !== userId)) return null
  return snapshotFromRow(row)
}

/** 项目的活动任务快照(断线/刷新恢复),单查询完成属主校验;无则返回 null */
export async function activeJobSnapshot(db: D1Database, projectId: string, userId: string) {
  const row = await db
    .prepare(
      `SELECT ${SNAPSHOT_COLUMNS} FROM jobs WHERE project_id = ? AND ${ACTIVE_STATUS_SQL}
       AND EXISTS (SELECT 1 FROM projects WHERE projects.id = jobs.project_id AND projects.user_id = ?)
       ORDER BY updated_at DESC LIMIT 1`
    )
    .bind(projectId, userId)
    .first<SnapshotRow>()
  return row ? snapshotFromRow(row) : null
}

export type JobSnapshot = NonNullable<Awaited<ReturnType<typeof jobSnapshot>>>
