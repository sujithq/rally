import type { ManagedPollReference } from './types'

const storageKey = 'rally-managed-polls'

function isManagedPollReference(value: unknown): value is ManagedPollReference {
  if (!value || typeof value !== 'object') return false
  const reference = value as ManagedPollReference
  return /^[a-f0-9]{10}$/.test(reference.id)
    && /^[a-f0-9]{48}$/.test(reference.managementToken)
}

export function getManagedPollReferences() {
  try {
    const references = JSON.parse(localStorage.getItem(storageKey) || '[]')
    return Array.isArray(references) ? references.filter(isManagedPollReference) : []
  } catch {
    return []
  }
}

export function rememberManagedPoll(reference: ManagedPollReference) {
  const references = getManagedPollReferences().filter(({ id }) => id !== reference.id)
  try {
    localStorage.setItem(storageKey, JSON.stringify([reference, ...references]))
  } catch {}
}

export function forgetManagedPoll(pollId: string) {
  const references = getManagedPollReferences().filter(({ id }) => id !== pollId)
  try {
    localStorage.setItem(storageKey, JSON.stringify(references))
  } catch {}
}

export function inviteUrl(pollId: string) {
  return `${window.location.origin}${window.location.pathname}#/p/${pollId}`
}

export function managementUrl(reference: ManagedPollReference) {
  return `${window.location.origin}${window.location.pathname}#/manage/${reference.id}/${reference.managementToken}`
}