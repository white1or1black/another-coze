import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../App'
import { api } from '../lib/api'

export default function TopBar() {
  const { user, setUser } = useAuth()
  const nav = useNavigate()

  async function logout() {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {})
    setUser(null)
    nav('/login')
  }

  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-gray-800 bg-gray-950 px-4">
      <Link to="/projects" className="flex items-center gap-2 font-semibold text-gray-100">
        <span className="h-2.5 w-2.5 rounded-sm bg-gradient-to-br from-indigo-400 to-fuchsia-500" />
        Forge
      </Link>
      <div className="flex items-center gap-4 text-sm text-gray-300">
        <span className="rounded-full bg-indigo-500/15 px-3 py-1 text-xs text-indigo-300">积分 {user?.credits ?? '-'}</span>
        <span className="hidden text-xs text-gray-500 sm:inline">{user?.email}</span>
        <button onClick={logout} className="text-xs text-gray-400 hover:text-gray-200">
          退出
        </button>
      </div>
    </header>
  )
}
