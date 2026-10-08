export type Env = {
  DB: D1Database
  ASSETS: Fetcher
  /** 生成工作流:持久执行引擎(见 src/workflow.ts) */
  GENERATION: Workflow
  LLM_BASE_URL: string
  LLM_API_KEY: string
  LLM_MODEL: string
  /** 可选:思考型模型的思维链控制,JSON 字符串原样透传给 OpenAI 兼容接口 */
  LLM_THINKING?: string
}

export interface SessionUser {
  id: string
  email: string
  credits: number
}

export type AppEnv = {
  Bindings: Env
  Variables: { user: SessionUser }
}

export interface UserRow {
  id: string
  email: string
  password_hash: string
  credits: number
  created_at: string
}

export interface ProjectRow {
  id: string
  user_id: string
  slug: string
  name: string
  description: string
  status: 'draft' | 'published'
  current_version: number
  created_at: string
  updated_at: string
}

export interface MessageRow {
  id: string
  project_id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
}

export interface Plan {
  name: string
  tagline: string
  palette: string[]
  /** 计划项;done 由工作流在对应项生成完成后回填,前端渲染勾选状态 */
  sections: { title: string; summary: string; done?: boolean }[]
}

/** 生成工作流入参:instance id 即 jobs.id */
export interface GenerationParams {
  jobId: string
}
