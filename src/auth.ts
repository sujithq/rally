import type { AuthSession } from './types'

const storageKey = 'rally-auth-session'

export function getSessionToken() {
  try {
    localStorage.removeItem(storageKey)
    return sessionStorage.getItem(storageKey) || ''
  } catch {
    return ''
  }
}

export function storeAuthSession(session: AuthSession) {
  try {
    localStorage.removeItem(storageKey)
    sessionStorage.setItem(storageKey, session.token)
  } catch {}
}

export function clearAuthSession() {
  try {
    localStorage.removeItem(storageKey)
    sessionStorage.removeItem(storageKey)
  } catch {}
}