export interface User {
  id: string
  email: string
  credits: number
}

export interface Project {
  id: string
  slug: string
  name: string
  description: string
  status: 'draft' | 'published'
  current_version: number
  created_at: string
  updated_at: string
}

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
}

export interface Plan {
  name: string
  tagline: string
  palette: string[]
  /** 计划项;done 由后端生成完成后回填,卡片实时勾选 */
  sections: { title: string; summary: string; done?: boolean }[]
}

/** 后台生成任务的状态快照(轮询/SSE 响应体,与服务端 jobSnapshot 对应) */
export interface JobSnapshot {
  id: string
  type: 'generate' | 'chat'
  status: 'pending' | 'running' | 'succeeded' | 'failed'
  stage: 'planning' | 'coding'
  /** 人读的分段进度(如「正在生成「关于我」(2/5)」),无则回退到按 stage 推导的文案 */
  progress: string | null
  /** 生成中的半成品页面(骨架+已完成计划项),流式预览用;终态后以详情接口的 html 为准 */
  html_preview: string | null
  plan: Plan | null
  error: string | null
  version: number | null
  elapsed: number
}

export interface ProjectDetail {
  project: Project
  messages: Message[]
  html: string | null
}

/** 站点数据(生成页面通过平台数据接口收集的访问者数据) */
export type SiteDataEnv = 'draft' | 'live'

export interface SiteCollection {
  env: SiteDataEnv
  collection: string
  count: number
}

export interface SiteDataItem {
  id: string
  data: Record<string, unknown>
  created_at: string
}
