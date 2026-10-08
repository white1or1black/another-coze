import type { Env } from '../types'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

function endpoint(env: Env): string {
  return `${env.LLM_BASE_URL.replace(/\/+$/, '')}/chat/completions`
}

/** 单次输出上限:显式设置是因为 OpenRouter 按 max_tokens 预扣额度,不传则按模型满额(131072)预检,
 *  低余额账号会被 402 拒绝;16K tokens 足够最重的单段(整页重写 ~15K tokens) */
const MAX_OUTPUT_TOKENS = 16384

function requestBody(env: Env, messages: ChatMessage[], stream: boolean, thinkingOverride?: unknown): string {
  const body: Record<string, unknown> = { model: env.LLM_MODEL, messages, stream, max_tokens: MAX_OUTPUT_TOKENS }
  // 思维链控制:调用方可覆盖(如分段排版代码禁用思考换速度);否则用环境配置
  if (thinkingOverride !== undefined) {
    body.thinking = thinkingOverride
  } else if (env.LLM_THINKING) {
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

/** 非流式单次请求的默认总超时:思考型模型规划阶段也可能静默较久,取宽松值 */
const REQUEST_TIMEOUT_MS = 150_000
/** 流式请求总超时(兜底,防无限流) */
const STREAM_TOTAL_MS = 600_000
/** 流式空闲看门狗:连续这么久收不到任何字节即判定挂死 */
const STREAM_IDLE_MS = 90_000

async function request(
  env: Env,
  messages: ChatMessage[],
  stream: boolean,
  timeoutMs: number,
  thinkingOverride?: unknown
): Promise<Response> {
  if (!env.LLM_BASE_URL || !env.LLM_API_KEY || !env.LLM_MODEL) {
    throw new Error('未配置 LLM,请复制 .dev.vars.example 为 .dev.vars 并填写')
  }
  let status = 0
  let bodyText = ''
  let timedOut = false
  // 最多 3 次尝试:指数退避(0.8s/1.6s)加随机抖动;429/503 优先遵循服务端 Retry-After(封顶 8s)
  // 每次尝试独立超时(signal 在循环内创建):网关挂起时中断等待,超时按瞬态失败走重试
  for (let attempt = 0; attempt < 3; attempt++) {
    const startedAt = Date.now()
    timedOut = false
    try {
      const res = await fetch(endpoint(env), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.LLM_API_KEY}` },
        body: requestBody(env, messages, stream, thinkingOverride),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (res.ok) {
        console.log(`[llm] ok attempt=${attempt + 1}/3 stream=${stream} ${Date.now() - startedAt}ms`)
        return res
      }
      status = res.status
      bodyText = await res.text().catch(() => '')
      console.log(`[llm] http-${status} attempt=${attempt + 1}/3 stream=${stream} ${Date.now() - startedAt}ms ${bodyText.slice(0, 200)}`)
      if (!retryable(status) || attempt === 2) break
      const retryAfter = Number(res.headers.get('retry-after'))
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 8000)
        : 800 * 2 ** attempt + Math.random() * 400
      await new Promise((r) => setTimeout(r, delay))
    } catch (err) {
      // 网络层异常(DNS/连接中断/超时):按瞬态失败退避重试;超时单独标记以便给出准确错误
      status = 0
      timedOut = (err as { name?: string }).name === 'TimeoutError'
      bodyText = err instanceof Error ? err.message : ''
      console.log(`[llm] ${timedOut ? 'timeout' : 'network-error'} attempt=${attempt + 1}/3 stream=${stream} ${Date.now() - startedAt}ms ${bodyText}`)
      // 超时不做内部重试:单次已等满超时上限,立即交给上层(workflow step)重试,避免最坏 3×超时才收敛
      if (timedOut || attempt === 2) break
      await new Promise((r) => setTimeout(r, 800 * 2 ** attempt + Math.random() * 400))
    }
  }
  throw new Error(
    timedOut
      ? `模型请求超时(单次上限 ${Math.round(timeoutMs / 1000)}s,已重试 3 次)`
      : friendlyError(status, bodyText)
  )
}

/** 非流式调用,返回完整回复文本;超时与思维链控制可按调用定制(整页生成耗时长需要放宽,分段排版代码可禁用思考换速度) */
export async function chatOnce(
  env: Env,
  messages: ChatMessage[],
  timeoutMs = REQUEST_TIMEOUT_MS,
  thinkingOverride?: unknown
): Promise<string> {
  const res = await request(env, messages, false, timeoutMs, thinkingOverride)
  const data = await res.json<{ choices?: { message?: { content?: string } }[] }>()
  return data.choices?.[0]?.message?.content ?? ''
}

/** 流式输出的分段:thinking 为思维链增量(思考型模型才有),code 为正文增量 */
export type StreamChunk = { type: 'thinking'; delta: string } | { type: 'code'; delta: string }

/** 流式调用,逐段 yield 思维链/正文增量(OpenAI 兼容 SSE 格式);空闲超过 STREAM_IDLE_MS 视为挂死 */
export async function* streamChat(env: Env, messages: ChatMessage[]): AsyncGenerator<StreamChunk> {
  const res = await request(env, messages, true, STREAM_TOTAL_MS)
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    // 看门狗:reader.read() 可能永久挂起(网关断流但不关闭连接),与空闲超时竞速
    const read = reader.read()
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const idle = new Promise<never>((_, reject) => {
      idleTimer = setTimeout(
        () => reject(new Error(`模型响应中断(流式空闲超过 ${STREAM_IDLE_MS / 1000}s 无任何数据)`)),
        STREAM_IDLE_MS
      )
    })
    let chunk: ReadableStreamReadResult<Uint8Array>
    try {
      chunk = await Promise.race([read, idle])
    } catch (err) {
      void reader.cancel().catch(() => {})
      throw err instanceof Error ? err : new Error('模型响应中断,请重试')
    } finally {
      if (idleTimer !== undefined) clearTimeout(idleTimer)
    }
    const { done, value } = chunk
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
