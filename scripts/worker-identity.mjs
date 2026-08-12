import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { validateConfig } from './validate-config.mjs'

function requireSecret(value, name, pattern) {
  const normalized = value?.trim() || ''
  if (!normalized || (pattern && !pattern.test(normalized))) {
    throw new Error(`${name} is missing or invalid.`)
  }
  return normalized
}

export function freshWorkerName(namespaceId) {
  const digest = crypto.createHash('sha256').update(namespaceId.toLowerCase()).digest('hex')
  return `rally-${digest.slice(0, 24)}`
}

async function workerBindings(response, workerName) {
  if (!response.ok) {
    throw new Error(`Could not inspect Worker bindings for ${workerName} (${response.status}).`)
  }
  try {
    const payload = await response.json()
    if (!payload.success || !Array.isArray(payload.result)) throw new Error()
    return payload.result
  } catch {
    throw new Error(`Worker ${workerName} did not return readable binding metadata.`)
  }
}

function usesNamespace(bindings, namespaceId) {
  return bindings.some((binding) => (
    binding.type === 'kv_namespace'
      && typeof binding.namespace_id === 'string'
      && binding.namespace_id.toLowerCase() === namespaceId
  ))
}

export async function workerIdentity({
  fetchImpl = fetch,
  accountId = process.env.CLOUDFLARE_ACCOUNT_ID,
  apiToken = process.env.CLOUDFLARE_API_TOKEN,
  namespaceId = process.env.CLOUDFLARE_KV_NAMESPACE_ID,
  instanceConfig = validateConfig(),
} = {}) {
  const normalizedAccountId = requireSecret(
    accountId,
    'CLOUDFLARE_ACCOUNT_ID',
    /^[a-f0-9]{32}$/i,
  )
  const normalizedNamespaceId = requireSecret(
    namespaceId,
    'CLOUDFLARE_KV_NAMESPACE_ID',
    /^[a-f0-9]{32}$/i,
  ).toLowerCase()
  const normalizedApiToken = requireSecret(apiToken, 'CLOUDFLARE_API_TOKEN')
  const workerName = instanceConfig.deployment.workerName
  const scriptsUrl = new URL(
    `/client/v4/accounts/${normalizedAccountId}/workers/scripts`,
    'https://api.cloudflare.com',
  )
  const headers = { Authorization: `Bearer ${normalizedApiToken}` }
  const listResponse = await fetchImpl(scriptsUrl, { headers })
  if (!listResponse.ok) {
    throw new Error(`Could not list deployed Workers (${listResponse.status}).`)
  }
  const payload = await listResponse.json()
  if (!payload.success || !Array.isArray(payload.result)) {
    throw new Error('Cloudflare returned an invalid Worker list.')
  }
  if (payload.result.some((script) => typeof script.id !== 'string' || !script.id)) {
    throw new Error('Cloudflare returned a Worker without an identity.')
  }

  const namespaceWorkers = []
  let configuredWorkerExists = false
  for (const candidate of payload.result) {
    const workerUrl = new URL(
      `/client/v4/accounts/${normalizedAccountId}/workers/services/`
        + `${encodeURIComponent(candidate.id)}/environments/production/bindings`,
      'https://api.cloudflare.com',
    )
    const bindings = await workerBindings(await fetchImpl(workerUrl, { headers }), candidate.id)
    if (candidate.id === workerName) configuredWorkerExists = true
    if (usesNamespace(bindings, normalizedNamespaceId)) namespaceWorkers.push(candidate.id)
  }

  if (namespaceWorkers.length > 1) {
    throw new Error(
      `The configured KV namespace is already shared by multiple Workers: `
      + `${namespaceWorkers.join(', ')}. Give each Rally instance its own namespace.`,
    )
  }
  if (namespaceWorkers.length === 1) {
    if (namespaceWorkers[0] !== workerName) {
      throw new Error(
        `This KV namespace is already deployed with Worker ${namespaceWorkers[0]}; `
        + `deployment.workerName is ${workerName}. Keep the existing name to preserve its `
        + 'Durable Object accounts and polls.',
      )
    }
    return workerName
  }
  if (configuredWorkerExists) {
    throw new Error(
      `Worker ${workerName} already exists but is not bound to the configured KV namespace. `
      + 'Check CLOUDFLARE_KV_NAMESPACE_ID; refusing to replace an existing deployment.',
    )
  }

  const expectedFreshName = freshWorkerName(normalizedNamespaceId)
  if (workerName !== expectedFreshName) {
    throw new Error(
      `This is a fresh KV namespace. Set deployment.workerName to ${expectedFreshName}. `
      + 'Fresh instances use a namespace-derived name to prevent concurrent deployments from '
      + 'creating separate Durable Object namespaces.',
    )
  }
  return workerName
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const workerName = await workerIdentity()
    console.log(`Validated Worker deployment identity: ${workerName}`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}