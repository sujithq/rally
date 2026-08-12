import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import defaultInstanceConfig from '../rally.config.json' with { type: 'json' }
import { createWranglerConfig } from './create-wrangler-config.mjs'
import { createReleaseFingerprint } from './release-fingerprint.mjs'

test('creates deployment configuration from instance settings and secrets', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rally-wrangler-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const outputPath = path.join(directory, 'wrangler.ci.json')
  const namespaceId = 'a'.repeat(32)

  const config = await createWranglerConfig({ namespaceId, outputPath })

  assert.equal(config.name, defaultInstanceConfig.deployment.workerName)
  assert.deepEqual(config.kv_namespaces, [{ binding: 'POLLS', id: namespaceId }])
  assert.deepEqual(config.vars, {
    RALLY_RELEASE_FINGERPRINT: await createReleaseFingerprint(),
  })
  assert.deepEqual(JSON.parse(await fs.readFile(outputPath, 'utf8')), config)
})

test('rejects an invalid KV namespace identifier', async () => {
  await assert.rejects(
    createWranglerConfig({ namespaceId: 'not-a-namespace-id' }),
    /32-character Cloudflare KV namespace ID/,
  )
})