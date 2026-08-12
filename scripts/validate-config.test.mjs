import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import defaultConfig from '../rally.config.json' with { type: 'json' }
import { validateConfig } from './validate-config.mjs'

function invalidConfig(update) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rally-config-'))
  const configPath = path.join(directory, 'rally.config.json')
  const config = structuredClone(defaultConfig)
  update(config)
  fs.writeFileSync(configPath, JSON.stringify(config))
  return { configPath, directory }
}

test('accepts the committed instance configuration', () => {
  assert.deepEqual(validateConfig(), defaultConfig)
})

test('rejects unknown settings', (context) => {
  const { configPath, directory } = invalidConfig((config) => {
    config.site.secret = 'must not be committed here'
  })
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  assert.throws(() => validateConfig(configPath), /unknown setting secret/)
})

test('requires registration to be closed when accounts are disabled', (context) => {
  const { configPath, directory } = invalidConfig((config) => {
    config.accounts.mode = 'disabled'
  })
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  assert.throws(() => validateConfig(configPath), /registration/)
})

test('requires HTTPS deployment origins without paths', (context) => {
  const { configPath, directory } = invalidConfig((config) => {
    config.deployment.allowedOrigins = ['http://example.com/path']
  })
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  assert.throws(() => validateConfig(configPath), /HTTPS origin/)
})