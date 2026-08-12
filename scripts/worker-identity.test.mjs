import assert from 'node:assert/strict'
import test from 'node:test'
import defaultInstanceConfig from '../rally.config.json' with { type: 'json' }
import { freshWorkerName, workerIdentity } from './worker-identity.mjs'

const namespaceId = 'b'.repeat(32)
const credentials = {
  accountId: 'a'.repeat(32),
  apiToken: 'test-token',
  namespaceId,
}

function scriptList(scripts) {
  return new Response(JSON.stringify({ success: true, result: scripts }), {
    headers: { 'Content-Type': 'application/json' },
  })
}

function workerScript(namespace, bindingName = 'POLLS') {
  const form = new FormData()
  form.set('metadata', JSON.stringify({
    bindings: namespace ? [{
      name: bindingName,
      type: 'kv_namespace',
      namespace_id: namespace,
    }] : [],
  }))
  form.set('index.js', new Blob(['export default {}'], { type: 'application/javascript' }))
  return new Response(form)
}

function rallyWorker(id) {
  return {
    id,
    exports: {
      PollCoordinator: { type: 'durable-object', storage: 'sqlite' },
      AccountCoordinator: { type: 'durable-object', storage: 'sqlite' },
    },
  }
}

function cloudflare(scripts, namespaces = {}) {
  return async (url) => {
    const pathname = new URL(url).pathname
    if (pathname.endsWith('/workers/scripts')) return scriptList(scripts)
    const workerName = decodeURIComponent(pathname.split('/').at(-1))
    return workerScript(namespaces[workerName])
  }
}

test('preserves an existing Worker bound to the configured namespace', async () => {
  const workerName = defaultInstanceConfig.deployment.workerName
  const result = await workerIdentity({
    ...credentials,
    instanceConfig: defaultInstanceConfig,
    fetchImpl: cloudflare([rallyWorker(workerName)], { [workerName]: namespaceId }),
  })
  assert.equal(result, workerName)
})

test('rejects renaming a Worker already bound to the namespace', async () => {
  const previousWorkerName = defaultInstanceConfig.deployment.workerName
  await assert.rejects(workerIdentity({
    ...credentials,
    instanceConfig: {
      ...defaultInstanceConfig,
      deployment: { ...defaultInstanceConfig.deployment, workerName: 'renamed-worker' },
    },
    fetchImpl: cloudflare(
      [rallyWorker(previousWorkerName)],
      { [previousWorkerName]: namespaceId },
    ),
  }), /already deployed with Worker rally-scheduler-api/)
})

test('finds namespace ownership on a legacy Worker without Rally exports', async () => {
  await assert.rejects(workerIdentity({
    ...credentials,
    instanceConfig: defaultInstanceConfig,
    fetchImpl: cloudflare(
      [{ id: 'legacy-worker' }],
      { 'legacy-worker': namespaceId },
    ),
  }), /already deployed with Worker legacy-worker/)
})

test('matches uppercase namespace secrets to lowercase Worker metadata', async () => {
  const workerName = defaultInstanceConfig.deployment.workerName
  const result = await workerIdentity({
    ...credentials,
    namespaceId: namespaceId.toUpperCase(),
    instanceConfig: defaultInstanceConfig,
    fetchImpl: cloudflare([rallyWorker(workerName)], { [workerName]: namespaceId }),
  })
  assert.equal(result, workerName)
})

test('finds the configured namespace under another binding name', async () => {
  const workerName = defaultInstanceConfig.deployment.workerName
  const result = await workerIdentity({
    ...credentials,
    instanceConfig: defaultInstanceConfig,
    fetchImpl: async (url) => new URL(url).pathname.endsWith('/workers/scripts')
      ? scriptList([rallyWorker(workerName)])
      : workerScript(namespaceId.toUpperCase(), 'LEGACY_DATA'),
  })
  assert.equal(result, workerName)
})

test('requires a deterministic Worker name for a fresh namespace', async () => {
  const expectedWorkerName = freshWorkerName(namespaceId)
  const result = await workerIdentity({
    ...credentials,
    instanceConfig: {
      ...defaultInstanceConfig,
      deployment: { ...defaultInstanceConfig.deployment, workerName: expectedWorkerName },
    },
    fetchImpl: cloudflare([]),
  })
  assert.equal(result, expectedWorkerName)

  await assert.rejects(workerIdentity({
    ...credentials,
    instanceConfig: defaultInstanceConfig,
    fetchImpl: cloudflare([]),
  }), new RegExp(`Set deployment\\.workerName to ${expectedWorkerName}`))
})

test('rejects a KV namespace shared by multiple Rally Workers', async () => {
  await assert.rejects(workerIdentity({
    ...credentials,
    instanceConfig: defaultInstanceConfig,
    fetchImpl: cloudflare(
      [rallyWorker('first-worker'), rallyWorker('second-worker')],
      { 'first-worker': namespaceId, 'second-worker': namespaceId },
    ),
  }), /shared by multiple Workers/)
})

test('rejects an occupied Worker name bound to another namespace', async () => {
  const workerName = defaultInstanceConfig.deployment.workerName
  await assert.rejects(workerIdentity({
    ...credentials,
    instanceConfig: defaultInstanceConfig,
    fetchImpl: cloudflare([rallyWorker(workerName)], { [workerName]: 'c'.repeat(32) }),
  }), /already exists but is not bound to the configured KV namespace/)
})

test('fails closed when Cloudflare Worker metadata cannot be inspected', async () => {
  await assert.rejects(workerIdentity({
    ...credentials,
    instanceConfig: defaultInstanceConfig,
    fetchImpl: async (url) => new URL(url).pathname.endsWith('/workers/scripts')
      ? scriptList([rallyWorker(defaultInstanceConfig.deployment.workerName)])
      : new Response('forbidden', { status: 403 }),
  }), /Could not inspect Worker rally-scheduler-api \(403\)/)
})