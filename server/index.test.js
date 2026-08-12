import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import defaultInstanceConfig from '../rally.config.json' with { type: 'json' }

let baseUrl
let server
let temporaryDirectory
let consumeRateLimit

before(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'rally-api-'))
  process.env.RALLY_DATA_FILE = path.join(temporaryDirectory, 'polls.json')
  process.env.RALLY_AUTH_DATA_FILE = path.join(temporaryDirectory, 'auth.json')
  process.env.RALLY_CONFIG_FILE = path.join(temporaryDirectory, 'rally.config.json')
  await fs.writeFile(process.env.RALLY_CONFIG_FILE, JSON.stringify({
    ...defaultInstanceConfig,
    polls: { ...defaultInstanceConfig.polls, maxResponses: 2 },
  }))

  const serverModule = await import('./index.js')
  consumeRateLimit = serverModule.consumeRateLimit
  server = serverModule.app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  baseUrl = `http://127.0.0.1:${address.port}`
})

after(async () => {
  if (server) {
    server.close()
    await once(server, 'close')
  }
  if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true })
})

async function request(pathname, options = {}) {
  const headers = new Headers(options.headers)
  if (options.body) headers.set('Content-Type', 'application/json')
  return fetch(`${baseUrl}${pathname}`, { ...options, headers })
}

function pollDraft(date = '2026-08-20') {
  return {
    title: 'Planning session',
    organizer: 'Ada',
    description: '',
    location: '',
    options: [{ date, time: '' }],
  }
}

test('bounds and expires in-memory rate-limit buckets', () => {
  const buckets = new Map([
    ['expired', { count: 1, resetAt: 999 }],
    ['active', { count: 1, resetAt: 2_000 }],
  ])
  assert.equal(consumeRateLimit(buckets, 'new', 5, 1_000, 1_000, 2), true)
  assert.deepEqual([...buckets.keys()].sort(), ['active', 'new'])
  assert.equal(consumeRateLimit(buckets, 'blocked', 5, 1_000, 1_000, 2), false)
  assert.equal(buckets.size, 2)
  assert.equal(consumeRateLimit(buckets, 'after-expiry', 5, 1_000, 2_001, 2), true)
  assert.deepEqual([...buckets.keys()], ['after-expiry'])
})

test('returns useful errors for malformed, oversized, and invalid poll requests', async () => {
  const malformed = await request('/api/polls', { method: 'POST', body: '{' })
  assert.equal(malformed.status, 400)
  assert.deepEqual(await malformed.json(), { error: 'Request body must be valid JSON.' })

  const oversized = await request('/api/polls', {
    method: 'POST',
    body: JSON.stringify({ padding: 'x'.repeat(70 * 1024) }),
  })
  assert.equal(oversized.status, 413)
  assert.deepEqual(await oversized.json(), { error: 'Request body is too large.' })

  const invalidDate = await request('/api/polls', {
    method: 'POST',
    body: JSON.stringify(pollDraft('2026-02-31')),
  })
  assert.equal(invalidDate.status, 400)
  assert.deepEqual(await invalidDate.json(), { error: 'Every option needs a valid date.' })
})

test('keeps edit tokens private and enforces the configured response limit', async () => {
  const createResponse = await request('/api/polls', {
    method: 'POST',
    body: JSON.stringify(pollDraft()),
  })
  assert.equal(createResponse.status, 201)
  const poll = await createResponse.json()
  const votes = { [poll.options[0].id]: 'yes' }

  const firstSave = await request(`/api/polls/${poll.id}/responses`, {
    method: 'PUT',
    body: JSON.stringify({ name: 'Ada', votes }),
  })
  const saved = await firstSave.json()
  const editToken = saved.participantId
  const publicParticipantId = saved.poll.viewerParticipantId
  assert.match(editToken, /^[a-f0-9]{48}$/)
  assert.match(publicParticipantId, /^[a-f0-9]{10}$/)
  assert.equal(saved.poll.participants[0].editTokenHash, undefined)

  await request(`/api/polls/${poll.id}/responses`, {
    method: 'PUT',
    body: JSON.stringify({ participantId: publicParticipantId, name: 'Mallory', votes }),
  })
  const updateResponse = await request(`/api/polls/${poll.id}/responses`, {
    method: 'PUT',
    body: JSON.stringify({ participantId: editToken, name: 'Ada Updated', votes }),
  })
  assert.equal(updateResponse.status, 200)

  const overflow = await request(`/api/polls/${poll.id}/responses`, {
    method: 'PUT',
    body: JSON.stringify({ name: 'Grace', votes }),
  })
  assert.equal(overflow.status, 409)
  assert.deepEqual(await overflow.json(), { error: 'This poll has reached its response limit.' })

  const anonymousPoll = await (await request(`/api/polls/${poll.id}`)).json()
  assert.equal(anonymousPoll.viewerParticipantId, undefined)
  assert.equal(anonymousPoll.participants.some((participant) => participant.editTokenHash), false)
  assert.deepEqual(
    anonymousPoll.participants.map((participant) => participant.name).sort(),
    ['Ada Updated', 'Mallory'],
  )
})

test('protects poll management and supports edits, closing, and deletion', async () => {
  const created = await (await request('/api/polls', {
    method: 'POST',
    body: JSON.stringify(pollDraft('2026-09-01')),
  })).json()
  assert.match(created.managementToken, /^[a-f0-9]{48}$/)
  assert.equal(created.managementTokenHash, undefined)

  const unauthorized = await request(`/api/polls/${created.id}/manage`)
  assert.equal(unauthorized.status, 403)
  const headers = { 'X-Rally-Management-Token': created.managementToken }
  const votes = { [created.options[0].id]: 'yes' }
  await request(`/api/polls/${created.id}/responses`, {
    method: 'PUT',
    body: JSON.stringify({ name: 'Grace', votes }),
  })

  const updateResponse = await request(`/api/polls/${created.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      title: 'Managed planning session',
      status: 'closed',
      options: [
        created.options[0],
        { date: '2026-09-02', time: '10:00' },
      ],
    }),
  })
  assert.equal(updateResponse.status, 200)
  const updated = await updateResponse.json()
  assert.equal(updated.title, 'Managed planning session')
  assert.equal(updated.status, 'closed')
  assert.equal(updated.participants[0].votes[updated.options[1].id], 'no')

  const closedResponse = await request(`/api/polls/${created.id}/responses`, {
    method: 'PUT',
    body: JSON.stringify({ name: 'Ada', votes }),
  })
  assert.equal(closedResponse.status, 409)

  const reopened = await request(`/api/polls/${created.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ status: 'open' }),
  })
  assert.equal(reopened.status, 200)
  assert.equal((await request(`/api/polls/${created.id}/manage`, { headers })).status, 200)

  const deleted = await request(`/api/polls/${created.id}`, { method: 'DELETE', headers })
  assert.equal(deleted.status, 200)
  assert.equal((await request(`/api/polls/${created.id}`)).status, 404)
})

test('keeps organizer-token access available when auth storage fails', async () => {
  const registration = await (await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Resilient organizer',
      email: 'resilient@example.com',
      password: 'correct horse battery staple',
    }),
  })).json()
  const poll = await (await request('/api/polls', {
    method: 'POST',
    body: JSON.stringify(pollDraft('2026-09-03')),
  })).json()
  const headers = {
    Authorization: `Bearer ${registration.token}`,
    'X-Rally-Management-Token': poll.managementToken,
  }
  const authFile = process.env.RALLY_AUTH_DATA_FILE
  const authBackup = `${authFile}.backup`
  await fs.rename(authFile, authBackup)
  await fs.mkdir(authFile)

  try {
    assert.equal((await request(`/api/polls/${poll.id}/manage`, { headers })).status, 200)
    assert.equal((await request(`/api/polls/${poll.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ title: 'Still manageable' }),
    })).status, 200)
    assert.equal((await request(`/api/polls/${poll.id}`, {
      method: 'DELETE',
      headers,
    })).status, 200)
  } finally {
    await fs.rm(authFile, { recursive: true, force: true })
    await fs.rename(authBackup, authFile)
  }
})

test('supports optional accounts without storing plaintext passwords', async () => {
  const password = 'correct horse battery staple'
  const registerResponse = await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Ada', email: 'ADA@example.com', password }),
  })
  assert.equal(registerResponse.status, 201)
  const registration = await registerResponse.json()
  assert.equal(registration.user.email, 'ada@example.com')
  assert.match(registration.token, /^[a-f0-9]{64}$/)

  const authFile = await fs.readFile(process.env.RALLY_AUTH_DATA_FILE, 'utf8')
  assert.equal(authFile.includes(password), false)
  assert.equal(authFile.includes(registration.token), false)
  const storedAuth = JSON.parse(authFile)
  assert.equal(storedAuth.accounts[0].password, undefined)
  assert.equal(storedAuth.accounts[0].passwordHash.algorithm, 'pbkdf2-sha256')
  assert.notEqual(storedAuth.accounts[0].passwordHash.hash, password)
  assert.equal(storedAuth.sessions[0].tokenHash === registration.token, false)

  const authorization = { Authorization: `Bearer ${registration.token}` }
  const created = await (await request('/api/polls', {
    method: 'POST',
    headers: authorization,
    body: JSON.stringify(pollDraft('2026-10-01')),
  })).json()
  assert.equal(created.ownerId, undefined)
  assert.equal((await request(`/api/polls/${created.id}/manage`, {
    headers: authorization,
  })).status, 200)

  const ownedPolls = await (await request('/api/account/polls', {
    headers: authorization,
  })).json()
  assert.deepEqual(ownedPolls.polls.map(({ id }) => id), [created.id])

  const anonymous = await (await request('/api/polls', {
    method: 'POST',
    body: JSON.stringify(pollDraft('2026-10-02')),
  })).json()
  const claimResponse = await request('/api/account/polls/claim', {
    method: 'POST',
    headers: {
      ...authorization,
      'X-Rally-Management-Token': anonymous.managementToken,
    },
    body: JSON.stringify({ pollId: anonymous.id }),
  })
  assert.equal(claimResponse.status, 200)
  assert.equal((await request(`/api/polls/${anonymous.id}/manage`, {
    headers: { 'X-Rally-Management-Token': anonymous.managementToken },
  })).status, 200)

  const wrongPassword = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'ada@example.com', password: 'not the password' }),
  })
  assert.equal(wrongPassword.status, 401)
  const loginResponse = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'ada@example.com', password }),
  })
  assert.equal(loginResponse.status, 200)

  assert.equal((await request('/api/auth/session', { headers: authorization })).status, 200)
  assert.equal((await request('/api/auth/session', {
    method: 'DELETE',
    headers: authorization,
  })).status, 200)
  assert.equal((await request('/api/auth/session', { headers: authorization })).status, 401)
  assert.equal((await request('/api/polls', {
    method: 'POST',
    headers: authorization,
    body: JSON.stringify(pollDraft('2026-10-03')),
  })).status, 401)
})

test('caps active Express sessions per account', async () => {
  const credentials = {
    email: 'sessions@example.com',
    password: 'correct horse battery staple',
  }
  const registration = await (await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Session owner', ...credentials }),
  })).json()
  for (let attempt = 0; attempt < 11; attempt += 1) {
    assert.equal((await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(credentials),
    })).status, 200)
  }

  const storedAuth = JSON.parse(await fs.readFile(process.env.RALLY_AUTH_DATA_FILE, 'utf8'))
  const accountSessions = storedAuth.sessions.filter(({ accountId }) => (
    accountId === registration.user.id
  ))
  assert.equal(accountSessions.length, 10)
})

test('throttles repeated Express sign-in attempts', async () => {
  const credentials = {
    email: 'grace@example.com',
    password: 'correct horse battery staple',
  }
  assert.equal((await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Grace', ...credentials }),
  })).status, 201)

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ ...credentials, password: 'incorrect password' }),
    })
    assert.equal(response.status, 401)
  }
  assert.equal((await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify(credentials),
  })).status, 429)

  const concurrentCredentials = {
    email: 'katherine@example.com',
    password: 'another correct password',
  }
  assert.equal((await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Katherine', ...concurrentCredentials }),
  })).status, 201)
  const concurrentAttempts = await Promise.all(Array.from({ length: 6 }, () => (
    request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        ...concurrentCredentials,
        password: 'incorrect password',
      }),
    })
  )))
  assert.deepEqual(concurrentAttempts.map(({ status }) => status).sort(), [401, 401, 401, 401, 401, 429])
})

test('throttles Express account registration before persisting another account', async () => {
  let limitedResponse
  for (let attempt = 0; attempt < 11; attempt += 1) {
    const response = await request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        name: `Rate limited organizer ${attempt}`,
        email: `rate-limited-${attempt}@example.com`,
        password: 'correct horse battery staple',
      }),
    })
    if (response.status === 429) {
      limitedResponse = response
      break
    }
    assert.equal(response.status, 201)
  }
  assert.ok(limitedResponse)
  assert.deepEqual(await limitedResponse.json(), {
    error: 'Too many account registrations. Try again later.',
  })

  const accountsAtLimit = JSON.parse(
    await fs.readFile(process.env.RALLY_AUTH_DATA_FILE, 'utf8'),
  ).accounts.length
  assert.equal((await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Blocked organizer',
      email: 'blocked-organizer@example.com',
      password: 'correct horse battery staple',
    }),
  })).status, 429)
  assert.equal(JSON.parse(
    await fs.readFile(process.env.RALLY_AUTH_DATA_FILE, 'utf8'),
  ).accounts.length, accountsAtLimit)
})