import { isDeepStrictEqual } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createReleaseFingerprint } from './release-fingerprint.mjs'
import { validateConfig } from './validate-config.mjs'

function positiveInteger(value, fallback) {
  return /^[1-9]\d*$/.test(value || '') ? Number(value) : fallback
}

function publicConfig(instanceConfig) {
  return {
    site: instanceConfig.site,
    accounts: instanceConfig.accounts,
    polls: instanceConfig.polls,
  }
}

export async function verifyDeployedConfig({
  instanceConfig = validateConfig(),
  fetchImpl = fetch,
  attempts = positiveInteger(process.env.RALLY_CONFIG_VERIFY_ATTEMPTS, 1),
  intervalMs = positiveInteger(process.env.RALLY_CONFIG_VERIFY_INTERVAL_MS, 10_000),
  wait = (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
  releaseFingerprint,
} = {}) {
  const expected = publicConfig(instanceConfig)
  const expectedReleaseFingerprint = releaseFingerprint
    || await createReleaseFingerprint({ instanceConfig })
  const configUrl = `${instanceConfig.deployment.apiBaseUrl}/api/config`
  let lastError

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(configUrl, { headers: { Accept: 'application/json' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const actual = await response.json()
      if (!isDeepStrictEqual(publicConfig(actual), expected)) {
        throw new Error('the public settings do not match')
      }
      if (actual.releaseFingerprint !== expectedReleaseFingerprint) {
        throw new Error('the Worker release fingerprint does not match')
      }
      return actual
    } catch (error) {
      lastError = error
      if (attempt < attempts) await wait(intervalMs)
    }
  }

  throw new Error(
    `The deployed API at ${configUrl} is not ready with rally.config.json: ${lastError.message}.`,
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await verifyDeployedConfig()
    console.log('The deployed API matches rally.config.json.')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}