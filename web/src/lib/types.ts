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
  sections: { title: string; summary: string }[]
}

/** 后台生成任务的状态快照(轮询/SSE 响应体,与服务端 jobSnapshot 对应) */
export interface JobSnapshot {
  id: string
  type: 'generate' | 'chat'
  status: 'pending' | 'running' | 'succeeded' | 'failed'
  stage: 'planning' | 'coding'
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
