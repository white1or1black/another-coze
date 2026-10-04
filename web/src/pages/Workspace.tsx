import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useAuth } from '../App'
import ChatPanel from '../components/ChatPanel'
import PreviewPane from '../components/PreviewPane'
import TopBar from '../components/TopBar'
import { api, sse } from '../lib/api'
import type { Message, Plan, Project, ProjectDetail } from '../lib/types'

export default function Workspace() {
  const { id } = useParams()
  const [sp, setSp] = useSearchParams()
  const { refresh } = useAuth()

  const [project, setProject] = useState<Project | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [html, setHtml] = useState<string | null>(null)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [thinking, setThinking] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [runningAction, setRunningAction] = useState<'generate' | 'chat' | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState('')
  const started = useRef(false)

  /** 消费 SSE:plan 事件 → code 增量(节流刷新预览)→ done 落定最终 HTML */
  const run = useCallback(
    async (action: 'generate' | 'chat', body: Record<string, string>, userText: string) => {
      setError('')
      setStreaming(true)
      setRunningAction(action)
      setElapsed(0)
      setThinking('')
      setMessages((m) => [...m, { id: crypto.randomUUID(), role: 'user', content: userText, created_at: '' }])
      if (action === 'generate') {
        setPlan(null)
        setHtml(null)
      }
      let acc = ''
      let lastFlush = 0
      try {
        await sse(`/api/projects/${id}/${action}`, body, (evt) => {
          if (evt.type === 'plan') {
            setPlan(evt.data)
          } else if (evt.type === 'thinking') {
            setThinking((t) => (t + evt.delta).slice(-400))
          } else if (evt.type === 'code') {
            if (!acc) setThinking('')
            acc += evt.delta
            const now = Date.now()
            if (now - lastFlush > 120) {
              lastFlush = now
              setHtml(acc)
            }
          } else if (evt.type === 'progress') {
            setElapsed(evt.elapsed)
          } else if (evt.type === 'done') {
            setThinking('')
            setHtml(evt.html)
            setProject((p) => (p ? { ...p, current_version: evt.version } : p))
            setMessages((m) => [
              ...m,
              { id: `v${evt.version}`, role: 'assistant', content: `已生成 v${evt.version}`, created_at: '' },
            ])
            refresh()
          } else if (evt.type === 'error') {
            setError(evt.message)
          }
        })
      } catch (err) {
        setError((err as Error).message)
      } finally {
        setStreaming(false)
        setRunningAction(null)
      }
    },
    [id, refresh]
  )

  /** 当前生成阶段的用户可读文案(chat 没有规划阶段;generate 在 plan 到达前是规划中) */
  const stageText = !streaming || !runningAction
    ? ''
    : runningAction === 'chat'
      ? '正在按你的要求修改页面'
      : plan
        ? '正在编写页面代码'
        : '正在规划方案'

  useEffect(() => {
    if (!id) return
    let cancelled = false
    ;(async () => {
      try {
        const detail = await api<ProjectDetail>(`/api/projects/${id}`)
        if (cancelled) return
        setProject(detail.project)
        setMessages(detail.messages)
        setHtml(detail.html)
        const idea = sp.get('idea')
        if (idea && !detail.html && !started.current) {
          started.current = true
          setSp({}, { replace: true })
          run('generate', { idea }, idea)
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
          thinking={thinking}
          error={error}
          stageText={stageText}
          elapsed={elapsed}
          onSend={(text) => {
            // 以服务端版本号判断:流式失败残留的半成品 HTML 不算有效版本,应继续走 generate
            if ((project?.current_version ?? 0) > 0) run('chat', { message: text }, text)
            else run('generate', { idea: text }, text)
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
