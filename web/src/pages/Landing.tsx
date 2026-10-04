import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../App'
import { api } from '../lib/api'

const EXAMPLES = ['精品咖啡店官网', '个人作品集', 'SaaS 产品落地页', '家常菜谱分享站', '宠物寄养服务', '婚礼策划工作室']

export default function Landing() {
  const [idea, setIdea] = useState('')
  const [busy, setBusy] = useState(false)
  const nav = useNavigate()
  const { user } = useAuth()

  async function start(text?: string) {
    const value = (text ?? idea).trim()
    if (!value || busy) return
    setBusy(true)
    try {
      const { id } = await api<{ id: string }>('/api/projects', { method: 'POST', body: { idea: value } })
      nav(`/workspace/${id}?idea=${encodeURIComponent(value)}`)
    } catch (err) {
      const e = err as Error & { status?: number }
      if (e.status === 401) nav(`/login?idea=${encodeURIComponent(value)}`)
      else alert(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <header className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
        <div className="flex items-center gap-2 font-semibold">
          <span className="h-2.5 w-2.5 rounded-sm bg-gradient-to-br from-indigo-400 to-fuchsia-500" />
          Forge
        </div>
        {user ? (
          <Link to="/projects" className="text-sm text-gray-300 hover:text-white">
            进入工作台
          </Link>
        ) : (
          <Link to="/login" className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm text-white hover:bg-indigo-500">
            登录 / 注册
          </Link>
        )}
      </header>

      <main className="mx-auto max-w-3xl px-4 pb-20 pt-20 text-center">
        <h1 className="text-4xl font-bold leading-tight sm:text-5xl">
          把想法锻造成
          <span className="bg-gradient-to-r from-indigo-400 to-fuchsia-400 bg-clip-text text-transparent">可上线的网站</span>
        </h1>
        <p className="mt-4 text-gray-400">描述你的想法,AI 负责规划与编码,片刻之后获得真实可用的页面,一键发布分享。</p>

        <div className="mt-10 rounded-2xl border border-gray-800 bg-gray-900 p-4 text-left shadow-xl">
          <textarea
            className="min-h-[120px] w-full resize-none bg-transparent px-2 py-1 text-base outline-none placeholder:text-gray-600"
            placeholder="例如:帮我做一个社区烘焙工作室的官网,展示招牌面包、价格和预约方式…"
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) start()
            }}
          />
          <div className="flex items-center justify-between border-t border-gray-800 pt-3">
            <span className="text-xs text-gray-500">每次生成消耗 1 积分 · 注册即送 20 积分</span>
            <button
              onClick={() => start()}
              disabled={busy || !idea.trim()}
              className="rounded-xl bg-indigo-600 px-5 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-40"
            >
              {busy ? '创建中…' : '开始生成'}
            </button>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap justify-center gap-2">
          {EXAMPLES.map((e) => (
            <button
              key={e}
              onClick={() => {
                setIdea(e)
                start(e)
              }}
              className="rounded-full border border-gray-700 px-3 py-1.5 text-xs text-gray-400 hover:border-indigo-500 hover:text-indigo-300"
            >
              {e}
            </button>
          ))}
        </div>
      </main>
    </div>
  )
}
