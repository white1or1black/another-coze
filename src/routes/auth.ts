import { Hono } from 'hono'
import type { AppEnv } from '../types'
import {
  clearSessionCookie,
  createSession,
  getSessionUser,
  hashPassword,
  isSecureRequest,
  sessionCookie,
  verifyPassword,
} from '../lib/auth'

const app = new Hono<AppEnv>()

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

type AuthBody = { email?: string; password?: string }

app.post('/register', async (c) => {
  const body = await c.req.json<AuthBody>().catch(() => ({}) as AuthBody)
  const email = String(body.email ?? '').trim().toLowerCase()
  const password = String(body.password ?? '')
  if (!EMAIL_RE.test(email)) return c.json({ error: '邮箱格式不正确' }, 400)
  if (password.length < 6) return c.json({ error: '密码至少 6 位' }, 400)

  const exists = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first()
  if (exists) return c.json({ error: '该邮箱已注册' }, 409)

  const id = crypto.randomUUID()
  await c.env.DB
    .prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)')
    .bind(id, email, await hashPassword(password))
    .run()

  const token = await createSession(c.env.DB, id)
  c.header('Set-Cookie', sessionCookie(token, isSecureRequest(c.req.url)))
  return c.json({ user: { id, email, credits: 20 } })
})

app.post('/login', async (c) => {
  const body = await c.req.json<AuthBody>().catch(() => ({}) as AuthBody)
  const email = String(body.email ?? '').trim().toLowerCase()
  const row = await c.env.DB
    .prepare('SELECT id, email, password_hash, credits FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: string; email: string; password_hash: string; credits: number }>()
  if (!row || !(await verifyPassword(String(body.password ?? ''), row.password_hash))) {
    return c.json({ error: '邮箱或密码错误' }, 401)
  }

  const token = await createSession(c.env.DB, row.id)
  c.header('Set-Cookie', sessionCookie(token, isSecureRequest(c.req.url)))
  return c.json({ user: { id: row.id, email: row.email, credits: row.credits } })
})

app.post('/logout', async (c) => {
  const m = /(?:^|;\s*)session=([^;]+)/.exec(c.req.header('Cookie') ?? '')
  if (m) await c.env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(m[1]).run()
  c.header('Set-Cookie', clearSessionCookie(isSecureRequest(c.req.url)))
  return c.json({ ok: true })
})

app.get('/me', async (c) => {
  const user = await getSessionUser(c.env.DB, c.req.raw)
  if (!user) return c.json({ error: '未登录' }, 401)
  return c.json({ user })
})

export const authRoutes = app
