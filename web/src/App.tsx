import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import Landing from './pages/Landing'
import Login from './pages/Login'
import Projects from './pages/Projects'
import Workspace from './pages/Workspace'
import { api } from './lib/api'
import type { User } from './lib/types'

interface AuthState {
  user: User | null
  setUser: (u: User | null) => void
  refresh: () => Promise<void>
  loading: boolean
}

export const AuthCtx = createContext<AuthState>({
  user: null,
  setUser: () => {},
  refresh: async () => {},
  loading: true,
})

export function useAuth() {
  return useContext(AuthCtx)
}

export default function App() {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  async function refresh() {
    try {
      const data = await api<{ user: User }>('/api/auth/me')
      setUser(data.user)
    } catch {
      setUser(null)
    }
  }

  useEffect(() => {
    refresh().finally(() => setLoading(false))
  }, [])

  return (
    <AuthCtx.Provider value={{ user, setUser, refresh, loading }}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/login" element={<Login />} />
          <Route
            path="/projects"
            element={
              <Guard>
                <Projects />
              </Guard>
            }
          />
          <Route
            path="/workspace/:id"
            element={
              <Guard>
                <Workspace />
              </Guard>
            }
          />
        </Routes>
      </BrowserRouter>
    </AuthCtx.Provider>
  )
}

function Guard({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth()
  if (loading) return <div className="flex h-screen items-center justify-center text-sm text-gray-400">加载中…</div>
  if (!user) return <Navigate to="/login" replace />
  return <>{children}</>
}
