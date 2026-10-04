import type { Env } from '../types'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

function endpoint(env: Env): string {
  return `${env.LLM_BASE_URL.replace(/\/+$/, '')}/chat/completions`
}

function requestBody(env: Env, messages: ChatMessage[], stream: boolean): string {
  const body: Record<string, unknown> = { model: env.LLM_MODEL, messages, stream }
  // 可选:思考型模型(GLM 5.x 等)的思维链控制,JSON 原样透传,如 {"type":"enabled","effort":"low"}
  if (env.LLM_THINKING) {
    try {
      body.thinking = JSON.parse(env.LLM_THINKING)
    } catch {
      // 配置非法时忽略,保持默认行为
    }
  }
  return JSON.stringify(body)
}

/** 值得重试的瞬态失败:0 代表连接未建立的 fetch 异常;GLM 网关偶发瞬时 401,408/429/5xx 均为瞬态 */
function retryable(status: number): boolean {
  return status === 0 || status === 401 || status === 408 || status === 429 || status >= 500
}

/** 重试耗尽后按状态码给出可直接展示给用户的消息 */
function friendlyError(status: number, body: string): string {
  if (status === 0) return '无法连接模型服务,请稍后重试'
  if (status === 401) return '模型 API Key 无效或已过期'
  if (status === 402) return '模型账户余额不足,请充值后重试'
  if (status === 403) return '模型服务拒绝访问,请检查 API Key 权限'
  if (status === 404) return '模型不存在,请检查 LLM_MODEL 配置'
  if (status === 429) return '模型限流中,请稍后重试'
  if (status >= 500) return '模型服务暂时不可用,请稍后重试'
  return `LLM 请求失败(${status}):${body.slice(0, 200)}`
}

async function request(env: Env, messages: ChatMessage[], stream: boolean): Promise<Response> {
  if (!env.LLM_BASE_URL || !env.LLM_API_KEY || !env.LLM_MODEL) {
    throw new Error('未配置 LLM,请复制 .dev.vars.example 为 .dev.vars 并填写')
  }
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.LLM_API_KEY}` },
    body: requestBody(env, messages, stream),
  }
  let status = 0
  let bodyText = ''
  // 最多 3 次尝试:指数退避(0.8s/1.6s)加随机抖动;429/503 优先遵循服务端 Retry-After(封顶 8s)
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(endpoint(env), init)
      if (res.ok) return res
      status = res.status
      bodyText = await res.text().catch(() => '')
      if (!retryable(status) || attempt === 2) break
      const retryAfter = Number(res.headers.get('retry-after'))
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 8000)
        : 800 * 2 ** attempt + Math.random() * 400
      await new Promise((r) => setTimeout(r, delay))
    } catch (err) {
      // 网络层异常(DNS/连接中断):按瞬态失败退避重试
      status = 0
      bodyText = err instanceof Error ? err.message : ''
      if (attempt === 2) break
      await new Promise((r) => setTimeout(r, 800 * 2 ** attempt + Math.random() * 400))
    }
  }
  throw new Error(friendlyError(status, bodyText))
}

/** 非流式调用,返回完整回复文本 */
export async function chatOnce(env: Env, messages: ChatMessage[]): Promise<string> {
  const res = await request(env, messages, false)
  const data = await res.json<{ choices?: { message?: { content?: string } }[] }>()
  return data.choices?.[0]?.message?.content ?? ''
}

/** 流式输出的分段:thinking 为思维链增量(思考型模型才有),code 为正文增量 */
export type StreamChunk = { type: 'thinking'; delta: string } | { type: 'code'; delta: string }

/** 流式调用,逐段 yield 思维链/正文增量(OpenAI 兼容 SSE 格式) */
export async function* streamChat(env: Env, messages: ChatMessage[]): AsyncGenerator<StreamChunk> {
  const res = await request(env, messages, true)
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (payload === '[DONE]') return
      try {
        const json = JSON.parse(payload) as {
          choices?: { delta?: { content?: string; reasoning_content?: string } }[]
        }
        const delta = json.choices?.[0]?.delta
        if (delta?.reasoning_content) yield { type: 'thinking', delta: delta.reasoning_content }
        if (delta?.content) yield { type: 'code', delta: delta.content }
      } catch {
        // 忽略无法解析的行(如注释或分段到达的不完整数据)
      }
    }
  }
}
