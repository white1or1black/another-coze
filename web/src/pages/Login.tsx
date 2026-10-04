import { useState, type FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../App'
import { api } from '../lib/api'
import type { User } from '../lib/types'

export default function Login() {
  const [sp] = useSearchParams()
  const idea = sp.get('idea') ?? ''
  const [mode, setMode] = useState<'login' | 'register'>(idea ? 'register' : 'login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const { setUser } = useAuth()
  const nav = useNavigate()

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const data = await api<{ user: User }>(`/api/auth/${mode}`, {
        method: 'POST',
        body: { email, password },
      })
      setUser(data.user)
      if (idea) {
        const project = await api<{ id: string }>('/api/projects', { method: 'POST', body: { idea } })
        nav(`/workspace/${project.id}?idea=${encodeURIComponent(idea)}`)
      } else {
        nav('/projects')
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-950 px-4 text-gray-100">
      <div className="w-full max-w-sm rounded-2xl border border-gray-800 bg-gray-900 p-6">
        <div className="mb-6 flex items-center gap-2 font-semibold">
          <span className="h-2.5 w-2.5 rounded-sm bg-gradient-to-br from-indigo-400 to-fuchsia-500" />
          Forge
        </div>

        <div className="mb-4 flex rounded-lg border border-gray-700 p-0.5 text-sm">
          {(['login', 'register'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`flex-1 rounded-md py-1.5 ${mode === m ? 'bg-gray-700 text-white' : 'text-gray-400'}`}
            >
              {m === 'login' ? '登录' : '注册'}
            </button>
          ))}
        </div>

        {idea && <p className="mb-3 rounded-lg bg-indigo-500/10 px-3 py-2 text-xs text-indigo-300">登录后继续生成:{idea}</p>}

        <form onSubmit={submit} className="space-y-3">
          <input
            type="email"
            required
            placeholder="邮箱"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-sm outline-none focus:border-indigo-500"
          />
          <input
            type="password"
            required
            minLength={6}
            placeholder="密码(至少 6 位)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-sm outline-none focus:border-indigo-500"
          />
          {error && <p className="text-xs text-red-400">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-xl bg-indigo-600 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-40"
          >
            {busy ? '提交中…' : mode === 'login' ? '登录' : '注册(送 20 积分)'}
          </button>
        </form>
      </div>
    </div>
  )
}
