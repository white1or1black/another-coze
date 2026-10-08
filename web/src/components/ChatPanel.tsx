import { useEffect, useRef, useState } from 'react'
import type { Message, Plan } from '../lib/types'

interface Props {
  messages: Message[]
  plan: Plan | null
  streaming: boolean
  error: string
  stageText: string
  elapsed: number
  onSend: (text: string) => void
}

export default function ChatPanel({ messages, plan, streaming, error, stageText, elapsed, onSend }: Props) {
  const [input, setInput] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages.length, plan, streaming, error])

  function submit() {
    const text = input.trim()
    if (!text || streaming) return
    onSend(text)
    setInput('')
  }

  return (
    <aside className="flex w-[380px] shrink-0 flex-col border-r border-gray-800 bg-gray-950">
      <div ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {messages.map((m) => (
          <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
                m.role === 'user' ? 'rounded-br-sm bg-indigo-600' : 'rounded-bl-sm bg-gray-800 text-gray-200'
              }`}
            >
              {m.content}
            </div>
          </div>
        ))}

        {plan && (
          <div className="rounded-xl border border-indigo-500/40 bg-indigo-500/10 p-3 text-sm">
            <div className="mb-1 font-semibold text-indigo-300">规划:{plan.name}</div>
            {plan.tagline && <div className="mb-2 text-xs text-gray-300">{plan.tagline}</div>}
            <div className="mb-2 flex gap-1">
              {plan.palette.map((c, i) => (
                <span key={i} className="h-4 w-4 rounded-full border border-white/20" style={{ background: c }} />
              ))}
            </div>
            <ul className="space-y-1 text-xs text-gray-300">
              {plan.sections.map((s, i) => (
                <li key={i}>
                  <span className="text-indigo-300">{s.title}</span>
                  {s.summary ? ` · ${s.summary}` : ''}
                </li>
              ))}
            </ul>
          </div>
        )}

        {streaming && (
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <span className="h-2 w-2 animate-pulse rounded-full bg-indigo-400" />
            <span>
              {stageText || '正在生成…'}
              {elapsed > 0 && <span className="ml-1 text-gray-500">· 已 {elapsed}s</span>}
            </span>
          </div>
        )}
        {error && <div className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">{error}</div>}
      </div>

      <div className="border-t border-gray-800 p-3">
        <div className="flex items-end gap-2">
          <textarea
            className="max-h-32 min-h-[44px] flex-1 resize-none rounded-xl border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none focus:border-indigo-500 disabled:opacity-50"
            placeholder={streaming ? '生成中…' : '描述你的想法,或提出修改要求…'}
            value={input}
            disabled={streaming}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
          />
          <button
            onClick={submit}
            disabled={streaming || !input.trim()}
            className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
          >
            发送
          </button>
        </div>
      </div>
    </aside>
  )
}
