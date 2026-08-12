import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateConfig } from './validate-config.mjs'
import { buildWranglerConfig } from './wrangler-config.mjs'

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const defaultBaseConfigPath = path.join(rootDirectory, 'wrangler.jsonc')
const releaseSupportFiles = [
  '.github/workflows/deploy-worker.yml',
  'package-lock.json',
  'package.json',
  'scripts/create-wrangler-config.mjs',
  'scripts/release-fingerprint.mjs',
  'scripts/wrangler-config.mjs',
]
const redactedNamespaceId = '<CLOUDFLARE_KV_NAMESPACE_ID>'
const redactedFingerprint = '<RALLY_RELEASE_FINGERPRINT>'

function compareText(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function contentDigest(content) {
  return crypto.createHash('sha256').update(content).digest('hex')
}

async function workerSourcePaths(directory = path.join(rootDirectory, 'worker')) {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...await workerSourcePaths(entryPath))
    } else if (!entry.name.includes('.test.')) {
      files.push(path.relative(rootDirectory, entryPath).replaceAll(path.sep, '/'))
    }
  }
  return files
}

export async function releaseFilePaths() {
  return [...releaseSupportFiles, ...await workerSourcePaths()]
    .sort(compareText)
}

export function fingerprintRelease({ instanceConfig, releaseFiles, wranglerConfig }) {
  const files = releaseFiles
    .map(({ name, content }) => ({
      name: name.replaceAll('\\', '/'),
      sha256: contentDigest(content),
    }))
    .sort((left, right) => compareText(left.name, right.name))
  if (new Set(files.map(({ name }) => name)).size !== files.length) {
    throw new Error('The release manifest contains duplicate file names.')
  }
  const manifest = {
    version: 2,
    instanceConfig,
    wranglerConfig,
    files,
  }
  const hash = crypto.createHash('sha256')
  hash.update(canonicalJson(manifest))
  return hash.digest('hex')
}

export async function createReleaseFingerprint({
  instanceConfig = validateConfig(),
  releaseFilePaths: requestedReleaseFilePaths,
  baseConfigPath = defaultBaseConfigPath,
} = {}) {
  const paths = requestedReleaseFilePaths || await releaseFilePaths()
  const releaseFiles = await Promise.all(paths.map(async (name) => ({
    name,
    content: await fs.readFile(path.resolve(rootDirectory, name)),
  })))
  const baseConfig = JSON.parse(await fs.readFile(baseConfigPath, 'utf8'))
  const wranglerConfig = buildWranglerConfig({
    baseConfig,
    instanceConfig,
    namespaceId: redactedNamespaceId,
    releaseFingerprint: redactedFingerprint,
  })
  return fingerprintRelease({ instanceConfig, releaseFiles, wranglerConfig })
}