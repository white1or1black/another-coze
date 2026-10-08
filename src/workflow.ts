import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import type { Env, GenerationParams, Plan } from './types'
import { chatOnce } from './lib/llm'
import { deductCredit } from './lib/credits'
import { insertMessage } from './lib/jobHelpers'
import {
  MAX_SEGMENTS,
  extractHtml,
  fallbackSectionHtml,
  parsePlan,
  planMessages,
  reviseMessages,
  sectionMessages,
  sectionPlaceholder,
  shellMessages,
  stripFence,
} from './lib/prompts'

/**
 * 每段 LLM 调用的单次超时。600s 已到实际收益上限:网关对非流式长请求约 5~6 分钟就可能自行 5xx,
 * 再放大只是让死请求拖更久;若仍有个别计划项超时,解法是拆小内容(规划限项数/概述收紧)而非加大超时
 */
const SEGMENT_TIMEOUT_MS = 600_000
/** chat 修改是整页重写,无法分段,保留长超时(网关长请求风险由 workflow 层重试兜底) */
const REWRITE_TIMEOUT_MS = 600_000
/** LLM 步骤失败后的自动重试:间隔 20s/40s,跨过网关的短暂「坏窗口」而不是几秒内连撞三次 */
const LLM_STEP_RETRIES = { limit: 2, delay: 20, backoff: 'exponential' } as const
// 注意:勿对分段调用强行禁用思考——「始终思考」型模型(如 glm-5.3-flash)不支持 disabled,
// 会返回 400 code 1210(只接受 low/high/max);思维链开销走环境变量 LLM_THINKING 控制

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

    const payload = JSON.parse(job.payload) as { idea?: string; message?: string; note?: string }
    const prompt = String(payload.idea ?? payload.message ?? '')
    // 失败续聊的补充要求:拼进喂给模型的想法里(断点复用匹配仍用原始 prompt,不受影响)
    const note = String(payload.note ?? '').trim()
    const effPrompt = note ? `${prompt}\n\n用户补充要求(务必落实):${note}` : prompt

    let html: string
    let plan: Plan | null = null
    let failedNote = ''
    if (job.type === 'generate') {
      // 复用检查:同项目、同想法的上次失败任务若留有产物(规划/骨架/已完成计划项),
      // 本次断点续跑只补缺失部分——用户「继续任务」而非从零重来
      const prior = await step.do('resume-lookup', async () => {
        const row = await db
          .prepare(
            `SELECT plan_json, sections_json FROM jobs
             WHERE project_id = ? AND id <> ? AND status = 'failed'
               AND sections_json IS NOT NULL AND json_extract(payload, '$.idea') = ?
             ORDER BY created_at DESC LIMIT 1`
          )
          .bind(job.project_id, jobId, prompt)
          .first<{ plan_json: string; sections_json: string }>()
        if (!row) return null
        try {
          return {
            plan: JSON.parse(row.plan_json) as Plan,
            artifacts: JSON.parse(row.sections_json) as {
              shell: string
              items: { title: string; html: string; ok: boolean }[]
            },
          }
        } catch {
          return null
        }
      })
      if (prior) {
        log(`resume: adopting prior plan + ${prior.artifacts.items.filter((x) => x.ok).length} completed items`)
      }

      // 阶段 1:规划(结果落库,前端轮询即可展示规划卡片);有可复用产物时直接继承上次规划
      const genPlan = await step.do(
        'planning',
        { retries: LLM_STEP_RETRIES },
        async () => {
          if (prior) {
            await setProgress('检测到上次未完成的生成,复用其规划')
            return prior.plan
          }
          await setProgress('正在规划方案')
          return chatOnce(this.env, planMessages(effPrompt)).then((t) => parsePlan(t, prompt))
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
          if (prior) return prior.artifacts.shell
          const doc = extractHtml(await chatOnce(this.env, shellMessages(effPrompt, genPlan), SEGMENT_TIMEOUT_MS))
          const missing = genPlan.sections
            .slice(0, MAX_SEGMENTS)
            .map((_, i) => i)
            .filter((i) => !doc.includes(`FORGE:SECTION:${i}`))
          if (!doc.includes('<') || missing.length) {
            throw new Error(`页面骨架生成无效(缺少内容占位符),请重试`)
          }
          await db
            .prepare(`UPDATE jobs SET html_preview = ?, sections_json = ?, updated_at = datetime('now') WHERE id = ?`)
            .bind(doc, JSON.stringify({ shell: doc, items: [] }), jobId)
            .run()
          return doc
        },
      )
      log('shell done')

      // 阶段 3:各计划项正文,顺序生成。实测同一 key 的并发请求会被网关排队(越靠后越久,
      // 第 4 个并行请求被饿到 17 分钟超时),串行反而更快更稳;每个计划项独立 checkpoint,
      // 任一失败只重试该项,进度精确到「第几项 + 名称」,完成即回填勾选到 plan_json
      const sections = genPlan.sections.slice(0, MAX_SEGMENTS)
      const priorItems = prior?.artifacts.items ?? []
      const items: { title: string; html: string; ok: boolean }[] = priorItems
        .slice(0, sections.length)
        .map((it) => ({ ...it }))
      const results: { html: string; ok: boolean }[] = []
      const failedTitles: string[] = []
      for (let i = 0; i < sections.length; i++) {
        const reused = priorItems[i]?.ok ? priorItems[i] : null
        let ok = true
        let out = ''
        try {
          out = await step.do(
            `section-${i}`,
            { retries: LLM_STEP_RETRIES },
            async () => {
              if (reused) {
                await setProgress(`复用上次结果:「${sections[i].title}」(${i + 1}/${sections.length})`)
                return reused.html
              }
              await setProgress(`正在生成「${sections[i].title}」(${i + 1}/${sections.length})`)
              const seg = stripFence(
                await chatOnce(this.env, sectionMessages(effPrompt, genPlan, i), SEGMENT_TIMEOUT_MS),
              )
              if (!seg.includes('<')) throw new Error(`「${sections[i].title}」未返回有效内容,请重试`)
              return seg
            },
          )
        } catch (err) {
          // 网关持续不可用:该计划项以占位块降级,不拖垮整个页面(卡片标 ✗,可对话补全)
          const msg = err instanceof Error ? err.message : '生成失败'
          log(`section-${i} FAILED: ${msg}`)
          ok = false
          failedTitles.push(sections[i].title)
          out = fallbackSectionHtml(sections[i].title, genPlan.palette)
        }
        // 新生成的成功项回填 sections_json(降级占位块不入库,留给下次继续补全)
        if (ok && !reused) {
          items[i] = { title: sections[i].title, html: out, ok: true }
          await db
            .prepare(`UPDATE jobs SET sections_json = ?, updated_at = datetime('now') WHERE id = ?`)
            .bind(JSON.stringify({ shell, items }), jobId)
            .run()
            .catch(() => {})
        } else if (!ok) {
          items[i] = { title: sections[i].title, html: out, ok: false }
        }
        results.push({ html: out, ok })
        // 勾选/标记 + 半成品页面上屏
        const htmlSoFar = results.reduce(
          (acc, r, j) => acc.replace(sectionPlaceholder(j), `\n${r.html}\n`),
          shell,
        )
        await db
          .prepare(`UPDATE jobs SET plan_json = ?, html_preview = ?, updated_at = datetime('now') WHERE id = ?`)
          .bind(
            JSON.stringify({
              ...genPlan,
              sections: genPlan.sections.map((s, j) =>
                j < results.length ? { ...s, done: results[j].ok, error: !results[j].ok } : s,
              ),
            }),
            htmlSoFar,
            jobId,
          )
          .run()
        log(`section-${i} ${ok ? (reused ? 'reused' : 'done') : 'degraded'}`)
      }
      html = results.reduce((acc, r, j) => acc.replace(sectionPlaceholder(j), `\n${r.html}\n`), shell)
      failedNote = failedTitles.length ? `(${failedTitles.length} 个板块生成失败:${failedTitles.join('、')},可在对话中要求补全)` : ''
      log(`sections done: ${results.length}, failed: ${failedTitles.length}`)
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

    // 提交:版本+项目更新在一个 D1 事务里原子落库;current_version 乐观锁防止迟到实例覆盖更新的版本
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
        // 乐观锁:WHERE current_version = 预期值——若已被更新的版本推进(如用户重试后的新任务),本版本只留档不覆盖
        job.type === 'generate' && plan
          ? db
              .prepare(
                `UPDATE projects SET current_version = ?, updated_at = datetime('now'),
                 name = COALESCE(?, name), description = COALESCE(?, description)
                 WHERE id = ? AND current_version = ?`
              )
              .bind(next, plan.name, plan.tagline, job.project_id, current.current_version)
          : db
              .prepare(`UPDATE projects SET current_version = ?, updated_at = datetime('now') WHERE id = ? AND current_version = ?`)
              .bind(next, job.project_id, current.current_version),
      ])
      return next
    })
    log(`version v${version} committed`)

    // 收尾:守卫式落定任务状态(幂等认领;被兜底判死但实例最终成功的行允许复活以交付页面),成功者才补消息与扣积分
    await step.do('finalize', async () => {
      const claim = await db
        .prepare(
          `UPDATE jobs SET status = 'succeeded', result_version = ?, error = NULL, updated_at = datetime('now')
           WHERE id = ? AND status IN ('running','failed')`
        )
        .bind(version, jobId)
        .run()
      if (!claim.meta.changes) return 'already-settled'
      const name = plan?.name ?? ''
      const assistantText =
        (job.type === 'generate'
          ? `已完成「${name || '网站'}」初版生成(v${version})`
          : `已按「${prompt.slice(0, 30)}」更新至 v${version}`) + failedNote
      await insertMessage(db, job.project_id, 'assistant', assistantText)
      // 成功才扣积分;失败/被巡检判死路径不扣
      await deductCredit(db, job.user_id)
      return 'settled'
    })
    log(`done v${version}`)
  }
}
