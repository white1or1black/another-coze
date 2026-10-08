import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import type { Env, GenerationParams, Plan } from './types'
import { chatOnce } from './lib/llm'
import { deductCredit } from './lib/credits'
import { insertMessage } from './lib/jobHelpers'
import {
  MAX_SEGMENTS,
  extractHtml,
  parsePlan,
  planMessages,
  reviseMessages,
  sectionMessages,
  sectionPlaceholder,
  shellMessages,
  stripFence,
} from './lib/prompts'

/** 每段 LLM 调用的单次超时:分段后单段 1~2 分钟即完成,远低于网关长请求风险区(200s+) */
const SEGMENT_TIMEOUT_MS = 240_000
/** chat 修改是整页重写,无法分段,保留长超时(网关长请求风险由 workflow 层重试兜底) */
const REWRITE_TIMEOUT_MS = 600_000
/** LLM 步骤失败后的自动重试:吸收网关瞬时 5xx/断流 */
const LLM_STEP_RETRIES = { limit: 2, delay: 8, backoff: 'exponential' } as const

/**
 * 生成工作流:持久执行引擎,取代原 waitUntil 执行体(免费版 waitUntil 约 2-4 分钟即被回收,
 * 撑不住 3~6 分钟的整页生成)。每个 step 的结果都被 checkpoint——实例中断后从最后一个
 * 完成的 step 自动恢复,已完成步骤不重跑;LLM 步骤失败自动按配置重试。
 *
 * generate 流程分四类 step:
 *   claim → planning → shell(骨架+占位符)→ section-0..N(章节正文,并行)→ assemble+commit
 * chat 流程:claim → revise(整页重写)→ commit
 */
export class GenerationWorkflow extends WorkflowEntrypoint<Env, GenerationParams> {
  async run(event: WorkflowEvent<GenerationParams>, step: WorkflowStep): Promise<void> {
    const jobId = event.payload.jobId
    const db = this.env.DB
    const startedMs = Date.now()
    const log = (msg: string) => console.log(`[wf] ${jobId.slice(0, 8)} ${msg} (${Math.round((Date.now() - startedMs) / 1000)}s)`)

    // 认领:pending → running;非 pending(被巡检判死等)则直接终止,结果被缓存不会重复执行
    const job = await step.do('claim', async () => {
      const row = await db
        .prepare(
          `UPDATE jobs SET status = 'running', stage = 'planning', started_at = datetime('now'),
           error = NULL, updated_at = datetime('now')
           WHERE id = ? AND status = 'pending'
           RETURNING project_id, user_id, type, payload`
        )
        .bind(jobId)
        .first<{ project_id: string; user_id: string; type: string; payload: string }>()
      if (!row) throw new Error('任务不存在或已不是 pending 状态')
      return row
    })
    log(`start type=${job.type}`)

    const payload = JSON.parse(job.payload) as { idea?: string; message?: string }
    const prompt = String(payload.idea ?? payload.message ?? '')

    let html: string
    let plan: Plan | null = null
    if (job.type === 'generate') {
      // 阶段 1:规划(结果落库,前端轮询即可展示规划卡片)
      const genPlan = await step.do(
        'planning',
        { retries: LLM_STEP_RETRIES },
        () => chatOnce(this.env, planMessages(prompt)).then((t) => parsePlan(t, prompt)),
      )
      plan = genPlan
      await step.do('plan-persist', async () => {
        await db
          .prepare(`UPDATE jobs SET stage = 'coding', plan_json = ?, updated_at = datetime('now') WHERE id = ?`)
          .bind(JSON.stringify(genPlan), jobId)
          .run()
      })
      log(`planning done: ${genPlan.name}, ${genPlan.sections.length} sections`)

      // 阶段 2:骨架(完整文档,正文仅含章节占位符)
      const shell = await step.do(
        'shell',
        { retries: LLM_STEP_RETRIES },
        async () => {
          const doc = extractHtml(await chatOnce(this.env, shellMessages(prompt, genPlan), SEGMENT_TIMEOUT_MS))
          const missing = genPlan.sections
            .slice(0, MAX_SEGMENTS)
            .map((_, i) => i)
            .filter((i) => !doc.includes(`FORGE:SECTION:${i}`))
          if (!doc.includes('<') || missing.length) {
            throw new Error(`骨架无效或缺少章节占位符:${missing.join(',') || '全部'}`)
          }
          return doc
        },
      )
      log('shell done')

      // 阶段 3:各章节正文,并行生成(每个章节独立 checkpoint,任一失败只重试该章节)
      const sections = genPlan.sections.slice(0, MAX_SEGMENTS)
      const filled = await Promise.all(
        sections.map((_, i) =>
          step.do(
            `section-${i}`,
            { retries: LLM_STEP_RETRIES },
            async () => {
              const seg = stripFence(await chatOnce(this.env, sectionMessages(prompt, genPlan, i), SEGMENT_TIMEOUT_MS))
              if (!seg.includes('<')) throw new Error(`章节 ${i} 未返回有效 HTML`)
              return seg
            },
          ),
        ),
      )
      log(`sections done: ${filled.length}`)

      // 组装:章节片段替换进骨架占位符
      html = shell
      filled.forEach((seg, i) => {
        html = html.replace(sectionPlaceholder(i), `\n${seg}\n`)
      })
    } else {
      // chat 修改:整页重写,单步完成(无法安全切分任意 HTML)
      html = await step.do(
        'revise',
        { retries: LLM_STEP_RETRIES },
        async () => {
          const current = await db
            .prepare('SELECT html FROM versions WHERE project_id = ? ORDER BY version_no DESC LIMIT 1')
            .bind(job.project_id)
            .first<{ html: string }>()
          if (!current) throw new Error('请先生成页面,再进行修改')
          const out = extractHtml(await chatOnce(this.env, reviseMessages(current.html, prompt), REWRITE_TIMEOUT_MS))
          if (!out.includes('<')) throw new Error('模型未返回有效页面,请重试')
          return out
        },
      )
      log('revise done')
    }

    if (!html.includes('<')) throw new Error('模型未返回有效页面,请重试')

    // 提交:版本+项目更新在一个 D1 事务里原子落库
    const version = await step.do('commit-version', async () => {
      const current = await db
        .prepare('SELECT current_version FROM projects WHERE id = ?')
        .bind(job.project_id)
        .first<{ current_version: number }>()
      if (!current) throw new Error('项目不存在')
      const next = current.current_version + 1
      await db.batch([
        // OR IGNORE:极端情况下步骤重放时版本已存在,靠 UNIQUE(project_id, version_no) 幂等
        db
          .prepare('INSERT OR IGNORE INTO versions (id, project_id, version_no, html, prompt) VALUES (?, ?, ?, ?, ?)')
          .bind(crypto.randomUUID(), job.project_id, next, html, prompt),
        job.type === 'generate' && plan
          ? db
              .prepare(
                `UPDATE projects SET current_version = ?, updated_at = datetime('now'),
                 name = COALESCE(?, name), description = COALESCE(?, description) WHERE id = ?`
              )
              .bind(next, plan.name, plan.tagline, job.project_id)
          : db
              .prepare(`UPDATE projects SET current_version = ?, updated_at = datetime('now') WHERE id = ?`)
              .bind(next, job.project_id),
      ])
      return next
    })
    log(`version v${version} committed`)

    // 收尾:先守卫式落定任务状态(幂等认领),成功者才补消息与扣积分
    await step.do('finalize', async () => {
      const claim = await db
        .prepare(
          `UPDATE jobs SET status = 'succeeded', result_version = ?, updated_at = datetime('now')
           WHERE id = ? AND status = 'running'`
        )
        .bind(version, jobId)
        .run()
      if (!claim.meta.changes) return 'already-settled'
      const name = plan?.name ?? ''
      const assistantText =
        job.type === 'generate'
          ? `已完成「${name || '网站'}」初版生成(v${version})`
          : `已按「${prompt.slice(0, 30)}」更新至 v${version}`
      await insertMessage(db, job.project_id, 'assistant', assistantText)
      // 成功才扣积分;失败/被巡检判死路径不扣
      await deductCredit(db, job.user_id)
      return 'settled'
    })
    log(`done v${version}`)
  }
}
