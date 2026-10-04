import type { Context, Next } from 'hono'
import type { AppEnv, SessionUser } from '../types'

const ITERATIONS = 100_000
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const encoder = new TextEncoder()

function toB64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function derive(password: string, salt: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, key, 256)
  return `pbkdf2:${ITERATIONS}:${toB64(salt)}:${toB64(new Uint8Array(bits))}`
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  return derive(password, salt)
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [, , saltB64] = stored.split(':')
  if (!saltB64) return false
  return (await derive(password, fromB64(saltB64))) === stored
}

export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function sessionCookie(token: string, secure: boolean): string {
  return `session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${secure ? '; Secure' : ''}`
}

export function clearSessionCookie(secure: boolean): string {
  return `session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`
}

export function isSecureRequest(url: string): boolean {
  const u = new URL(url)
  return u.protocol === 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1'
}

function readToken(request: Request): string | null {
  const m = /(?:^|;\s*)session=([^;]+)/.exec(request.headers.get('Cookie') ?? '')
  return m ? m[1] : null
}

export async function createSession(db: D1Database, userId: string): Promise<string> {
  const token = newToken()
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString()
  await db
    .prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(token, userId, expiresAt)
    .run()
  return token
}

export async function getSessionUser(db: D1Database, request: Request): Promise<SessionUser | null> {
  const token = readToken(request)
  if (!token) return null
  const row = await db
    .prepare('SELECT u.id, u.email, u.credits, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?')
    .bind(token)
    .first<{ id: string; email: string; credits: number; expires_at: string }>()
  if (!row) return null
  if (row.expires_at <= new Date().toISOString()) {
    await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run()
    return null
  }
  return { id: row.id, email: row.email, credits: row.credits }
}

export async function requireUser(c: Context<AppEnv>, next: Next) {
  const user = await getSessionUser(c.env.DB, c.req.raw)
  if (!user) return c.json({ error: '未登录' }, 401)
  c.set('user', user)
  await next()
}
