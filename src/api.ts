import type { CreatedPoll, Poll, PollDraft, PollUpdate, SavedResponse, Vote } from './types'

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
  return request<CreatedPoll>('/api/polls', {
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

function managementHeaders(managementToken: string, includeContentType = false) {
  return {
    ...(includeContentType ? { 'Content-Type': 'application/json' } : {}),
    'X-Rally-Management-Token': managementToken,
  }
}

export function getManagedPoll(pollId: string, managementToken: string) {
  return request<Poll>(`/api/polls/${pollId}/manage`, {
    headers: managementHeaders(managementToken),
  })
}

export function updatePoll(pollId: string, managementToken: string, update: PollUpdate) {
  return request<Poll>(`/api/polls/${pollId}`, {
    method: 'PATCH',
    headers: managementHeaders(managementToken, true),
    body: JSON.stringify(update),
  })
}

export function deletePoll(pollId: string, managementToken: string) {
  return request<{ deleted: true }>(`/api/polls/${pollId}`, {
    method: 'DELETE',
    headers: managementHeaders(managementToken),
  })
}