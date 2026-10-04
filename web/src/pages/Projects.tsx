import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import TopBar from '../components/TopBar'
import { api } from '../lib/api'
import type { Project } from '../lib/types'

export default function Projects() {
  const [items, setItems] = useState<Project[] | null>(null)
  const nav = useNavigate()

  useEffect(() => {
    api<{ projects: Project[] }>('/api/projects')
      .then((data) => setItems(data.projects))
      .catch(() => setItems([]))
  }, [])

  async function remove(id: string) {
    if (!confirm('删除后不可恢复,确定删除该项目?')) return
    await api(`/api/projects/${id}`, { method: 'DELETE' })
    setItems((list) => (list ?? []).filter((p) => p.id !== id))
  }

  return (
    <div className="flex min-h-screen flex-col bg-gray-950 text-gray-100">
      <TopBar />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-xl font-semibold">我的项目</h1>
          <button
            onClick={() => nav('/')}
            className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium hover:bg-indigo-500"
          >
            新建项目
          </button>
        </div>

        {items === null ? (
          <p className="text-sm text-gray-500">加载中…</p>
        ) : items.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-gray-800 py-20 text-center text-sm text-gray-500">
            还没有项目,去首页描述一个想法开始创建吧。
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((p) => (
              <div key={p.id} className="flex flex-col rounded-2xl border border-gray-800 bg-gray-900 p-4">
                <div className="mb-2 flex items-start justify-between gap-2">
                  <h2 className="line-clamp-1 font-medium">{p.name || '未命名项目'}</h2>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
                      p.status === 'published' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-gray-700/60 text-gray-400'
                    }`}
                  >
                    {p.status === 'published' ? '已发布' : '草稿'}
                  </span>
                </div>
                <p className="mb-4 line-clamp-2 min-h-8 flex-1 text-sm text-gray-500">{p.description || '暂无描述'}</p>
                <div className="mb-3 flex items-center justify-between text-xs text-gray-600">
                  <span>v{p.current_version}</span>
                  <span>{p.updated_at.slice(0, 16).replace('T', ' ')}</span>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => nav(`/workspace/${p.id}`)}
                    className="flex-1 rounded-xl bg-indigo-600 py-1.5 text-sm hover:bg-indigo-500"
                  >
                    打开
                  </button>
                  <button
                    onClick={() => remove(p.id)}
                    className="rounded-xl border border-gray-700 px-3 py-1.5 text-sm text-gray-400 hover:border-red-500/50 hover:text-red-400"
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
