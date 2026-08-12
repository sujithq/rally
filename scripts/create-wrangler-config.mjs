import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createReleaseFingerprint } from './release-fingerprint.mjs'
import { validateConfig } from './validate-config.mjs'
import { buildWranglerConfig } from './wrangler-config.mjs'

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const defaultBaseConfigPath = path.join(rootDirectory, 'wrangler.jsonc')
const defaultOutputPath = path.join(rootDirectory, 'wrangler.ci.json')

export async function createWranglerConfig({
  namespaceId = process.env.CLOUDFLARE_KV_NAMESPACE_ID,
  baseConfigPath = defaultBaseConfigPath,
  outputPath = defaultOutputPath,
} = {}) {
  if (!/^[a-f0-9]{32}$/i.test(namespaceId?.trim() || '')) {
    throw new Error(
      'CLOUDFLARE_KV_NAMESPACE_ID must be a 32-character Cloudflare KV namespace ID.',
    )
  }

  const instanceConfig = validateConfig()
  const baseConfig = JSON.parse(await fs.readFile(baseConfigPath, 'utf8'))
  const wranglerConfig = buildWranglerConfig({
    baseConfig,
    instanceConfig,
    namespaceId: namespaceId.trim(),
    releaseFingerprint: await createReleaseFingerprint({ instanceConfig }),
  })

  await fs.writeFile(outputPath, `${JSON.stringify(wranglerConfig, null, 2)}\n`)
  return wranglerConfig
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outputPath = path.resolve(process.argv[2] || defaultOutputPath)
  try {
    await createWranglerConfig({ outputPath })
    console.log(`Created Worker configuration: ${path.relative(rootDirectory, outputPath)}`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}