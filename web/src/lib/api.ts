import type { Plan } from './types'

export async function api<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? 'GET',
    headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
  if (!res.ok) {
    let message = `请求失败(${res.status})`
    try {
      const data = (await res.json()) as { error?: string }
      if (data.error) message = data.error
    } catch {
      // 保留默认消息
    }
    const err = new Error(message) as Error & { status: number }
    err.status = res.status
    throw err
  }
  return (await res.json()) as T
}

export type SseEvent =
  | { type: 'plan'; data: Plan }
  | { type: 'thinking'; delta: string }
  | { type: 'code'; delta: string }
  | { type: 'progress'; elapsed: number }
  | { type: 'done'; version: number; html: string; credits: number }
  | { type: 'error'; message: string }

/** POST 方式的 SSE 消费(EventSource 不支持 POST,故手动解析流) */
export async function sse(url: string, body: unknown, onEvent: (event: SseEvent) => void): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok || !res.body) {
    let message = `请求失败(${res.status})`
    try {
      const data = (await res.json()) as { error?: string }
      if (data.error) message = data.error
    } catch {
      // 保留默认消息
    }
    throw new Error(message)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  // 流必须以 done/error 事件收尾;否则说明连接被意外掐断(worker 崩溃/网络断),要明确告知用户
  let terminated = false
  const handle = (evt: SseEvent) => {
    if (evt.type === 'done' || evt.type === 'error') terminated = true
    onEvent(evt)
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const parts = buf.split('\n\n')
      buf = parts.pop() ?? ''
      for (const part of parts) {
        const line = part.trim()
        if (!line.startsWith('data:')) continue
        try {
          handle(JSON.parse(line.slice(5).trim()) as SseEvent)
        } catch {
          // 忽略不完整数据
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {})
  }
  if (!terminated) throw new Error('生成连接中断,本次未完成,请重新发送(未扣除积分)')
}
