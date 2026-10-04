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

export interface ProjectDetail {
  project: Project
  messages: Message[]
  html: string | null
}

/** 站点数据(生成页面通过平台数据接口收集的访问者数据) */
export interface SiteCollection {
  collection: string
  count: number
}

export interface SiteDataItem {
  id: string
  data: Record<string, unknown>
  created_at: string
}
