import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useAuth } from '../App'
import ChatPanel from '../components/ChatPanel'
import PreviewPane from '../components/PreviewPane'
import TopBar from '../components/TopBar'
import { api, getActiveJob, startJob, subscribeJob } from '../lib/api'
import type { JobSnapshot, Message, Plan, Project, ProjectDetail } from '../lib/types'

export default function Workspace() {
  const { id } = useParams()
  const [sp, setSp] = useSearchParams()
  const { refresh } = useAuth()

  const [project, setProject] = useState<Project | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [html, setHtml] = useState<string | null>(null)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [job, setJob] = useState<JobSnapshot | null>(null)
  const [error, setError] = useState('')
  const [resumeIdea, setResumeIdea] = useState<string | null>(null)
  const started = useRef(false)

  const streaming = !!job && (job.status === 'pending' || job.status === 'running')
  const runningAction = job?.type ?? null
  const elapsed = job?.elapsed ?? 0

  /** 拉取项目详情,同步服务端最新状态(版本、消息);返回是否成功,由调用方决定如何提示 */
  const reloadDetail = useCallback(async (): Promise<boolean> => {
    if (!id) return false
    try {
      const detail = await api<ProjectDetail>(`/api/projects/${id}`)
      setProject(detail.project)
      setMessages(detail.messages)
      setHtml(detail.html)
      return true
    } catch {
      return false
    }
  }, [id])

  /** 任务收尾:成功则刷新详情与积分,失败则展示错误(幂等:同一任务只结算一次) */
  const settled = useRef(new Set<string>())
  const settle = useCallback(
    async (finished: JobSnapshot) => {
      if (settled.current.has(finished.id)) return
      settled.current.add(finished.id)
      if (finished.status === 'failed') {
        // 失败但有产物:记下原想法,后续消息作为补充要求继续该任务
        if (finished.idea) setResumeIdea(finished.idea)
        setError(finished.error ?? '生成失败,请重试')
        return
      }
      setResumeIdea(null)
      setPlan((p) => (finished.type === 'generate' && finished.plan ? finished.plan : p))
      // 结果落定依赖这次拉取:瞬时失败退避重试,避免“积分已扣但界面显示失败”
      for (let attempt = 0; ; attempt++) {
        if (await reloadDetail()) break
        if (attempt >= 2) {
          setError('生成结果同步失败,请刷新页面查看最新版本')
          return
        }
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
      }
      refresh()
    },
    [reloadDetail, refresh]
  )

  /** 创建后台任务;服务端已落用户消息,前端本地补一条保证即时反馈 */
  const run = useCallback(
    async (action: 'generate' | 'chat', body: Record<string, string>, userText: string) => {
      setError('')
      const localId = crypto.randomUUID()
      setMessages((m) => [...m, { id: localId, role: 'user', content: userText, created_at: '' }])
      if (action === 'generate') {
        setPlan(null)
        setHtml(null)
      }
      try {
        const { jobId } = await startJob(`/api/projects/${id}/${action}`, body)
        setResumeIdea(null)
        setJob({
          id: jobId,
          type: action,
          status: 'pending',
          stage: 'planning',
          progress: null,
          html_preview: null,
          idea: action === 'generate' ? (body.idea ?? null) : null,
          plan: null,
          error: null,
          version: null,
          elapsed: 0,
        })
      } catch (err) {
        setError((err as Error).message)
        // 只按 id 回滚刚插入的本地消息,不影响历史里同文的消息
        setMessages((m) => m.filter((x) => x.id !== localId))
      }
    },
    [id]
  )

  /** 订阅任务进度:SSE 推送、断线自动降级轮询都在 subscribeJob 内部处理;终态时结算 */
  useEffect(() => {
    if (!job || !streaming) return
    const apply = (next: JobSnapshot) => {
      setJob(next)
      if (next.plan) setPlan(next.plan)
      // 分段实时预览:骨架完成即可见框架,每个计划项完成时长出对应部分
      if (next.html_preview) setHtml(next.html_preview)
      if (next.status === 'succeeded' || next.status === 'failed') void settle(next)
    }
    // 进度彻底拿不到(会话过期/持续断网):结束任务态并提示,避免输入被永久禁用
    return subscribeJob(job.id, apply, (message) => {
      setJob(null)
      setError(message)
    })
  }, [job?.id, streaming, settle])

  /** 当前生成阶段的用户可读文案:优先展示工作流写入的分段进度,无则按 stage 推导 */
  const stageText = !streaming || !runningAction
    ? ''
    : job?.progress
      ? job.progress
      : runningAction === 'chat'
        ? '正在按你的要求修改页面'
        : job?.stage === 'coding' || plan
          ? '正在编写页面代码'
          : '正在规划方案'

  useEffect(() => {
    if (!id) return
    let cancelled = false
    ;(async () => {
      try {
        const [detail, { job: active, resume }] = await Promise.all([
          api<ProjectDetail>(`/api/projects/${id}`),
          getActiveJob(id),
        ])
        if (cancelled) return
        setProject(detail.project)
        setMessages(detail.messages)
        setHtml(detail.html)
        // 断线/刷新恢复:有进行中的任务则接管订阅;此时项目被任务占用,?idea 自动重发只会 409,故跳过
        if (active) {
          setJob(active)
          if (active.plan) setPlan(active.plan)
          if (active.html_preview) setHtml(active.html_preview)
          return
        }
        // 失败续聊恢复:上次任务失败但有产物,恢复卡片与半成品预览,后续消息将继续该任务
        if (resume) {
          setResumeIdea(resume.idea)
          if (resume.plan) setPlan(resume.plan)
          if (resume.html_preview) setHtml(resume.html_preview)
        }
        const idea = sp.get('idea')
        if (idea && !detail.html && !started.current) {
          started.current = true
          setSp({}, { replace: true })
          void run('generate', { idea }, idea)
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  async function publish() {
    if (!id || !project) return
    try {
      const data = await api<{ slug: string; url: string }>(`/api/projects/${id}/publish`, { method: 'POST' })
      setProject((p) => (p ? { ...p, status: 'published', slug: data.slug } : p))
      window.open(data.url, '_blank')
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <div className="flex h-screen flex-col bg-gray-950 text-gray-100">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <ChatPanel
          messages={messages}
          plan={plan}
          streaming={streaming}
          error={error}
          stageText={stageText}
          elapsed={elapsed}
          onSend={(text) => {
            // 成功过 → 对话修改;失败但有产物 → 继续该任务(原想法 + 本条消息作为补充要求);否则全新生成
            if ((project?.current_version ?? 0) > 0) void run('chat', { message: text }, text)
            else if (resumeIdea) void run('generate', { idea: resumeIdea, note: text }, text)
            else void run('generate', { idea: text }, text)
          }}
        />
        <PreviewPane
          html={html}
          streaming={streaming}
          progressText={stageText ? `${stageText} · 已 ${elapsed}s` : ''}
          project={project}
          onPublish={publish}
        />
      </div>
    </div>
  )
}
