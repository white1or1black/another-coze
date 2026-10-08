import type { JobSnapshot } from './types'

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

/** 创建后台生成任务,立即返回 jobId */
export function startJob(path: string, body: Record<string, string>): Promise<{ jobId: string }> {
  return api<{ jobId: string }>(path, { method: 'POST', body })
}

const POLL_INTERVAL_MS = 2000
/** 连续轮询失败上限(会话过期/持续断网时终止订阅,避免无限静默重试) */
const MAX_POLL_FAILURES = 3

/**
 * 订阅任务进度:优先 SSE 推送,连接断开自动降级为轮询,全程通过 onUpdate 输出统一快照,
 * 到达终态后自行停止。返回取消函数;连续多次轮询失败时调用 onError(此时任务可能仍在
 * 服务端执行,调用方应结束任务态并提示用户刷新恢复)
 */
export function subscribeJob(
  jobId: string,
  onUpdate: (job: JobSnapshot) => void,
  onError: (message: string) => void
): () => void {
  const es = new EventSource(`/api/jobs/${jobId}/events`)
  let terminal = false
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let failures = 0

  const stop = () => {
    es.close()
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  const apply = (job: JobSnapshot) => {
    if (job.status === 'succeeded' || job.status === 'failed') {
      terminal = true
      stop()
    }
    onUpdate(job)
  }

  const startPolling = () => {
    if (pollTimer || terminal) return
    pollTimer = setInterval(async () => {
      try {
        const job = await getJob(jobId)
        failures = 0
        if (job) apply(job)
      } catch {
        failures += 1
        if (failures >= MAX_POLL_FAILURES) {
          stop()
          onError('任务进度获取失败,请稍后刷新页面查看结果')
        }
      }
    }, POLL_INTERVAL_MS)
  }

  es.onmessage = (e) => {
    try {
      apply(JSON.parse(e.data) as JobSnapshot)
    } catch {
      // 忽略不完整数据
    }
  }
  es.onerror = () => {
    // 服务端推完终态会主动关流,浏览器触发 onerror 并尝试重连 —— 已拿到终态,直接关闭即可
    if (terminal) {
      stop()
      return
    }
    // 连接异常(网络断/代理掐断/会话过期):降级为轮询,任务本身不受影响
    es.close()
    startPolling()
  }
  return stop
}

export async function getJob(jobId: string): Promise<JobSnapshot | null> {
  const data = await api<{ job: JobSnapshot | null }>(`/api/jobs/${jobId}`)
  return data.job
}

/** 活动任务(接管轮询)+ 可续任务(最近一次失败但有产物的任务,继续对话即续跑) */
export async function getActiveJob(
  projectId: string
): Promise<{ job: JobSnapshot | null; resume: JobSnapshot | null }> {
  const data = await api<{ job: JobSnapshot | null; resume: JobSnapshot | null }>(
    `/api/projects/${projectId}/job/active`,
  )
  return { job: data.job ?? null, resume: data.resume ?? null }
}
