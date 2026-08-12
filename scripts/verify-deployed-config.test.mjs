import assert from 'node:assert/strict'
import test from 'node:test'
import defaultInstanceConfig from '../rally.config.json' with { type: 'json' }
import { verifyDeployedConfig } from './verify-deployed-config.mjs'

const releaseFingerprint = 'a'.repeat(64)

function response(config, deployedReleaseFingerprint = releaseFingerprint) {
  return new Response(JSON.stringify({
    maxDates: config.polls.maxDates,
    site: config.site,
    accounts: config.accounts,
    polls: config.polls,
    releaseFingerprint: deployedReleaseFingerprint,
  }), { headers: { 'Content-Type': 'application/json' } })
}

test('accepts a deployed API with matching public settings', async () => {
  const result = await verifyDeployedConfig({
    instanceConfig: defaultInstanceConfig,
    fetchImpl: async () => response(defaultInstanceConfig),
    releaseFingerprint,
  })
  assert.deepEqual(result.accounts, defaultInstanceConfig.accounts)
})

test('waits for a concurrent Worker deployment to publish matching settings', async () => {
  let attempts = 0
  let waits = 0
  await verifyDeployedConfig({
    instanceConfig: defaultInstanceConfig,
    attempts: 2,
    intervalMs: 1,
    wait: async () => { waits += 1 },
    releaseFingerprint,
    fetchImpl: async () => {
      attempts += 1
      return response(attempts === 1
        ? {
            ...defaultInstanceConfig,
            accounts: { mode: 'required', registration: 'closed' },
          }
        : defaultInstanceConfig)
    },
  })
  assert.equal(attempts, 2)
  assert.equal(waits, 1)
})

test('rejects an API with stale public settings', async () => {
  await assert.rejects(verifyDeployedConfig({
    instanceConfig: defaultInstanceConfig,
    releaseFingerprint,
    fetchImpl: async () => response({
      ...defaultInstanceConfig,
      polls: { ...defaultInstanceConfig.polls, maxResponses: 1 },
    }),
  }), /public settings do not match/)
})

test('rejects stale Worker code with otherwise matching public settings', async () => {
  await assert.rejects(verifyDeployedConfig({
    instanceConfig: defaultInstanceConfig,
    releaseFingerprint,
    fetchImpl: async () => response(defaultInstanceConfig, 'b'.repeat(64)),
  }), /Worker release fingerprint does not match/)
})