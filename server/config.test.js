import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import defaultInstanceConfig from '../rally.config.json' with { type: 'json' }

async function startConfiguredServer(accounts, directory) {
  directory ||= await fs.mkdtemp(path.join(os.tmpdir(), 'rally-config-api-'))
  const environment = {
    RALLY_CONFIG_FILE: path.join(directory, 'rally.config.json'),
    RALLY_DATA_FILE: path.join(directory, 'polls.json'),
    RALLY_AUTH_DATA_FILE: path.join(directory, 'auth.json'),
  }
  await fs.writeFile(environment.RALLY_CONFIG_FILE, JSON.stringify({
    ...defaultInstanceConfig,
    accounts,
  }))

  const previousEnvironment = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]]),
  )
  Object.assign(process.env, environment)
  let app
  try {
    ;({ app } = await import(`./index.js?config-test=${randomUUID()}`))
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true })
    throw error
  } finally {
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }

  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  const baseUrl = `http://127.0.0.1:${address.port}`

  return {
    async request(pathname, options = {}) {
      const headers = new Headers(options.headers)
      if (options.body) headers.set('Content-Type', 'application/json')
      return fetch(`${baseUrl}${pathname}`, { ...options, headers })
    },
    async close({ removeDirectory = true } = {}) {
      server.close()
      await once(server, 'close')
      if (removeDirectory) await fs.rm(directory, { recursive: true, force: true })
    },
  }
}

function pollDraft() {
  return {
    title: 'Planning session',
    organizer: 'Ada',
    description: '',
    location: '',
    options: [{ date: '2026-08-20', time: '' }],
  }
}

test('disables Express account routes while preserving anonymous poll creation', async () => {
  const api = await startConfiguredServer({ mode: 'disabled', registration: 'closed' })
  try {
    const publicConfig = await (await api.request('/api/config')).json()
    assert.deepEqual(publicConfig.accounts, { mode: 'disabled', registration: 'closed' })
    assert.equal(publicConfig.deployment, undefined)

    const credentials = {
      email: 'ada@example.com',
      password: 'correct horse battery staple',
    }
    assert.equal((await api.request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ name: 'Ada', ...credentials }),
    })).status, 403)
    assert.equal((await api.request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(credentials),
    })).status, 403)
    assert.equal((await api.request('/api/account/polls')).status, 403)
    assert.equal((await api.request('/api/polls', {
      method: 'POST',
      headers: { Authorization: 'Bearer ignored-when-accounts-are-disabled' },
      body: JSON.stringify(pollDraft()),
    })).status, 201)
  } finally {
    await api.close()
  }
})

test('requires an Express account for poll creation when configured', async () => {
  const api = await startConfiguredServer({ mode: 'required', registration: 'open' })
  try {
    assert.equal((await api.request('/api/polls', {
      method: 'POST',
      body: JSON.stringify(pollDraft()),
    })).status, 401)

    const registration = await (await api.request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Ada',
        email: 'required@example.com',
        password: 'correct horse battery staple',
      }),
    })).json()
    assert.equal((await api.request('/api/polls', {
      method: 'POST',
      headers: { Authorization: `Bearer ${registration.token}` },
      body: JSON.stringify(pollDraft()),
    })).status, 201)
  } finally {
    await api.close()
  }
})

test('closes Express registration without disabling sign-in', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rally-config-api-'))
  const credentials = {
    email: 'closed@example.com',
    password: 'correct horse battery staple',
  }
  const openApi = await startConfiguredServer(
    { mode: 'optional', registration: 'open' },
    directory,
  )
  assert.equal((await openApi.request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Ada', ...credentials }),
  })).status, 201)
  await openApi.close({ removeDirectory: false })

  const api = await startConfiguredServer(
    { mode: 'optional', registration: 'closed' },
    directory,
  )
  try {
    const registration = await api.request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Grace',
        email: 'new-account@example.com',
        password: credentials.password,
      }),
    })
    assert.equal(registration.status, 403)
    assert.deepEqual(await registration.json(), { error: 'Registration is closed.' })
    assert.equal((await api.request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(credentials),
    })).status, 200)
  } finally {
    await api.close()
  }
})

test('rejects invalid Express instance configuration at startup', async () => {
  await assert.rejects(
    startConfiguredServer({ mode: 'unexpected', registration: 'open' }),
    /Invalid Rally configuration/,
  )
})