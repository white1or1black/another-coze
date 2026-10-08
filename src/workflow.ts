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
 *   claim → planning → shell(骨架+占位符)→ section-0..N(计划项正文,顺序)→ assemble+commit
 * chat 流程:claim → revise(整页重写)→ commit
 */
export class GenerationWorkflow extends WorkflowEntrypoint<Env, GenerationParams> {
  async run(event: WorkflowEvent<GenerationParams>, step: WorkflowStep): Promise<void> {
    const jobId = event.payload.jobId
    const db = this.env.DB
    const startedMs = Date.now()
    const log = (msg: string) => console.log(`[wf] ${jobId.slice(0, 8)} ${msg} (${Math.round((Date.now() - startedMs) / 1000)}s)`)
    // 分段进度落库(前端轮询/SSE 展示);写在各 step 体内,重放/重试时重复写同值,幂等
    const setProgress = (text: string) =>
      db.prepare(`UPDATE jobs SET progress = ?, updated_at = datetime('now') WHERE id = ?`).bind(text, jobId).run()

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
        async () => {
          await setProgress('正在规划方案')
          return chatOnce(this.env, planMessages(prompt)).then((t) => parsePlan(t, prompt))
        },
      )
      plan = genPlan
      await step.do('plan-persist', async () => {
        await db
          .prepare(`UPDATE jobs SET stage = 'coding', progress = ?, updated_at = datetime('now') WHERE id = ?`)
          .bind('正在生成页面骨架', jobId)
          .run()
      })
      log(`planning done: ${genPlan.name}, ${genPlan.sections.length} sections`)

      // 阶段 2:骨架(完整文档,正文仅含计划项占位符)。完成即写 html_preview,预览立刻能看到页面框架
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
            throw new Error(`页面骨架生成无效(缺少内容占位符),请重试`)
          }
          await db
            .prepare(`UPDATE jobs SET html_preview = ?, updated_at = datetime('now') WHERE id = ?`)
            .bind(doc, jobId)
            .run()
          return doc
        },
      )
      log('shell done')

      // 阶段 3:各计划项正文,顺序生成。实测同一 key 的并发请求会被网关排队(越靠后越久,
      // 第 4 个并行请求被饿到 17 分钟超时),串行反而更快更稳;每个计划项独立 checkpoint,
      // 任一失败只重试该项,进度精确到「第几项 + 名称」,完成即回填勾选到 plan_json
      const sections = genPlan.sections.slice(0, MAX_SEGMENTS)
      const filled: string[] = []
      for (let i = 0; i < sections.length; i++) {
        const seg = await step.do(
          `section-${i}`,
          { retries: LLM_STEP_RETRIES },
          async () => {
            await setProgress(`正在生成「${sections[i].title}」(${i + 1}/${sections.length})`)
            const out = stripFence(await chatOnce(this.env, sectionMessages(prompt, genPlan, i), SEGMENT_TIMEOUT_MS))
            if (!out.includes('<')) throw new Error(`「${sections[i].title}」未返回有效内容,请重试`)
            // 勾选计划卡片 + 半成品页面上屏:该项标记完成,已完成的片段拼进 html_preview
            const htmlSoFar = [...filled, out].reduce(
              (acc, s, j) => acc.replace(sectionPlaceholder(j), `\n${s}\n`),
              shell,
            )
            await db
              .prepare(`UPDATE jobs SET plan_json = ?, html_preview = ?, updated_at = datetime('now') WHERE id = ?`)
              .bind(
                JSON.stringify({
                  ...genPlan,
                  sections: genPlan.sections.map((s, j) => (j <= i ? { ...s, done: true } : s)),
                }),
                htmlSoFar,
                jobId,
              )
              .run()
            return out
          },
        )
        filled.push(seg)
        log(`section-${i} done`)
      }
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
      await setProgress('正在组装并保存页面')
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
