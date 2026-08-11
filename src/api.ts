import { getSessionToken } from './auth'
import type {
  AccountUser,
  AuthSession,
  CreatedPoll,
  Poll,
  PollDraft,
  PollUpdate,
  SavedResponse,
  Vote,
} from './types'

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${url}`, options)
  const payload = (await response.json()) as T & { error?: string }

  if (!response.ok) {
    throw new ApiError(payload.error || 'The request could not be completed.', response.status)
  }

  return payload
}

export function createPoll(draft: PollDraft) {
  return request<CreatedPoll>('/api/polls', {
    method: 'POST',
    headers: sessionHeaders(true),
    body: JSON.stringify(draft),
  })
}

export function getPoll(pollId: string, participantToken?: string) {
  return request<Poll>(`/api/polls/${pollId}`, {
    headers: participantToken ? { 'X-Rally-Participant-Token': participantToken } : undefined,
  })
}

export function getConfig() {
  return request<{ maxDates: number | null }>('/api/config')
}

export function saveResponse(
  pollId: string,
  response: { participantId?: string; name: string; votes: Record<string, Vote> },
) {
  return request<SavedResponse>(`/api/polls/${pollId}/responses`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(response),
  })
}

function sessionHeaders(includeContentType = false) {
  const sessionToken = getSessionToken()
  return {
    ...(includeContentType ? { 'Content-Type': 'application/json' } : {}),
    ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
  }
}

function managementHeaders(managementToken = '', includeContentType = false) {
  return {
    ...sessionHeaders(includeContentType),
    ...(managementToken ? { 'X-Rally-Management-Token': managementToken } : {}),
  }
}

export function getManagedPoll(pollId: string, managementToken = '') {
  return request<Poll>(`/api/polls/${pollId}/manage`, {
    headers: managementHeaders(managementToken),
  })
}

export function updatePoll(pollId: string, managementToken: string | undefined, update: PollUpdate) {
  return request<Poll>(`/api/polls/${pollId}`, {
    method: 'PATCH',
    headers: managementHeaders(managementToken, true),
    body: JSON.stringify(update),
  })
}

export function deletePoll(pollId: string, managementToken = '') {
  return request<{ deleted: true }>(`/api/polls/${pollId}`, {
    method: 'DELETE',
    headers: managementHeaders(managementToken),
  })
}

export function registerAccount(details: { name: string; email: string; password: string }) {
  return request<AuthSession>('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(details),
  })
}

export function loginAccount(credentials: { email: string; password: string }) {
  return request<AuthSession>('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
  })
}

export function getAccountSession() {
  return request<{ user: AccountUser }>('/api/auth/session', {
    headers: sessionHeaders(),
  })
}

export function logoutAccount() {
  return request<{ signedOut: true }>('/api/auth/session', {
    method: 'DELETE',
    headers: sessionHeaders(),
  })
}

export async function getAccountPolls() {
  const polls: Poll[] = []
  let cursor = ''

  do {
    const page = await request<{ polls: Poll[]; nextCursor?: string }>(
      `/api/account/polls${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
      { headers: sessionHeaders() },
    )
    polls.push(...page.polls)
    cursor = page.nextCursor || ''
  } while (cursor)

  return { polls }
}

export function claimAccountPoll(pollId: string, managementToken: string) {
  return request<Poll>('/api/account/polls/claim', {
    method: 'POST',
    headers: managementHeaders(managementToken, true),
    body: JSON.stringify({ pollId }),
  })
}