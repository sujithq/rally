import type { Poll, PollDraft, SavedResponse, Vote } from './types'

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${url}`, options)
  const payload = (await response.json()) as T & { error?: string }

  if (!response.ok) {
    throw new Error(payload.error || 'The request could not be completed.')
  }

  return payload
}

export function createPoll(draft: PollDraft) {
  return request<Poll>('/api/polls', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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