import assert from 'node:assert/strict'
import test from 'node:test'
import defaultInstanceConfig from '../rally.config.json' with { type: 'json' }
import { fingerprintRelease, releaseFilePaths } from './release-fingerprint.mjs'

const releaseFiles = [
  { name: 'worker/index.js', content: 'export default {}' },
  { name: 'scripts/wrangler-config.mjs', content: 'export function build() {}' },
]
const wranglerConfig = {
  main: 'worker/index.js',
  name: defaultInstanceConfig.deployment.workerName,
  kv_namespaces: [{ binding: 'POLLS', id: '<CLOUDFLARE_KV_NAMESPACE_ID>' }],
  vars: { RALLY_RELEASE_FINGERPRINT: '<RALLY_RELEASE_FINGERPRINT>' },
}

test('fingerprints the full instance configuration and release manifest', () => {
  const fingerprint = fingerprintRelease({
    instanceConfig: defaultInstanceConfig,
    releaseFiles,
    wranglerConfig,
  })
  assert.match(fingerprint, /^[a-f0-9]{64}$/)

  assert.notEqual(fingerprint, fingerprintRelease({
    instanceConfig: {
      ...defaultInstanceConfig,
      deployment: {
        ...defaultInstanceConfig.deployment,
        allowedOrigins: [...defaultInstanceConfig.deployment.allowedOrigins, 'https://example.com'],
      },
    },
    releaseFiles,
    wranglerConfig,
  }))
  assert.notEqual(fingerprint, fingerprintRelease({
    instanceConfig: defaultInstanceConfig,
    releaseFiles: releaseFiles.map((file) => file.name === 'worker/index.js'
      ? { ...file, content: `${file.content}\n// changed` }
      : file),
    wranglerConfig,
  }))
  assert.notEqual(fingerprint, fingerprintRelease({
    instanceConfig: defaultInstanceConfig,
    releaseFiles,
    wranglerConfig: { ...wranglerConfig, compatibility_date: '2099-01-01' },
  }))
})

test('does not depend on object property or file order', () => {
  const reorderedConfig = Object.fromEntries(Object.entries(defaultInstanceConfig).reverse())
  assert.equal(
    fingerprintRelease({ instanceConfig: defaultInstanceConfig, releaseFiles, wranglerConfig }),
    fingerprintRelease({
      instanceConfig: reorderedConfig,
      releaseFiles: [...releaseFiles].reverse(),
      wranglerConfig,
    }),
  )
})

test('release files cover Worker sources, generated config, and deployment toolchain', async () => {
  const paths = await releaseFilePaths()
  assert.ok(paths.includes('worker/index.js'))
  assert.ok(paths.includes('scripts/create-wrangler-config.mjs'))
  assert.ok(paths.includes('scripts/release-fingerprint.mjs'))
  assert.ok(paths.includes('scripts/wrangler-config.mjs'))
  assert.ok(paths.includes('.github/workflows/deploy-worker.yml'))
  assert.ok(paths.includes('package.json'))
  assert.ok(paths.includes('package-lock.json'))
  assert.ok(!paths.includes('worker/index.test.js'))
})