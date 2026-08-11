import assert from 'node:assert/strict'
import test from 'node:test'
import worker from './index.js'

class MemoryKv {
  values = new Map()
  metadata = new Map()

  async get(key, type) {
    const value = this.values.get(key)
    if (value === undefined) return null
    return type === 'json' ? JSON.parse(value) : value
  }

  async put(key, value, options = {}) {
    this.values.set(key, value)
    if (options.metadata) this.metadata.set(key, options.metadata)
  }

  async list({ prefix, limit = 1000 }) {
    const keys = [...this.values.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort()
      .slice(0, limit)
      .map((name) => ({ name, metadata: this.metadata.get(name) }))
    return { keys, list_complete: true }
  }
}

function createEnvironment(overrides = {}) {
  return {
    POLLS: new MemoryKv(),
    MAX_POLL_DATES: 'unlimited',
    MAX_POLL_RESPONSES: '100',
    ALLOWED_ORIGINS: 'https://sujithq.github.io',
    ...overrides,
  }
}

function call(environment, path, options = {}) {
  const headers = new Headers(options.headers)
  headers.set('Origin', 'https://sujithq.github.io')
  if (options.body) headers.set('Content-Type', 'application/json')
  return worker.fetch(new Request(`https://rally-api.example${path}`, { ...options, headers }), environment)
}

function pollDraft(optionCount) {
  return {
    title: 'Planning session',
    organizer: 'Ada',
    description: '',
    location: '',
    options: Array.from({ length: optionCount }, (_, index) => ({
      date: `2026-08-${String(index + 10).padStart(2, '0')}`,
      time: '',
    })),
  }
}

test('creates an unlimited poll and stores concurrent responses separately', async () => {
  const environment = createEnvironment()
  const createResponse = await call(environment, '/api/polls', {
    method: 'POST',
    body: JSON.stringify(pollDraft(10)),
  })
  assert.equal(createResponse.status, 201)
  const poll = await createResponse.json()
  assert.equal(poll.options.length, 10)

  const votes = Object.fromEntries(poll.options.map((option) => [option.id, 'yes']))
  const responses = await Promise.all(
    ['Ada', 'Grace'].map((name) => call(environment, `/api/polls/${poll.id}/responses`, {
      method: 'PUT',
      body: JSON.stringify({ name, votes }),
    })),
  )
  assert.deepEqual(responses.map((response) => response.status), [200, 200])

  const getResponse = await call(environment, `/api/polls/${poll.id}`)
  const savedPoll = await getResponse.json()
  assert.deepEqual(savedPoll.participants.map((participant) => participant.name).sort(), ['Ada', 'Grace'])
})

test('enforces a configured date limit', async () => {
  const environment = createEnvironment({ MAX_POLL_DATES: '2' })
  const response = await call(environment, '/api/polls', {
    method: 'POST',
    body: JSON.stringify(pollDraft(3)),
  })

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: 'Polls can include up to 2 dates.' })
})

test('keeps edit tokens private and does not authorize updates with public participant IDs', async () => {
  const environment = createEnvironment()
  const createResponse = await call(environment, '/api/polls', {
    method: 'POST',
    body: JSON.stringify(pollDraft(1)),
  })
  const poll = await createResponse.json()
  const votes = { [poll.options[0].id]: 'yes' }

  const saveResponse = await call(environment, `/api/polls/${poll.id}/responses`, {
    method: 'PUT',
    body: JSON.stringify({ name: 'Ada', votes }),
  })
  const saved = await saveResponse.json()
  const editToken = saved.participantId
  const publicParticipantId = saved.poll.viewerParticipantId
  assert.match(editToken, /^[a-f0-9]{48}$/)
  assert.match(publicParticipantId, /^[a-f0-9]{10}$/)
  assert.notEqual(editToken, publicParticipantId)

  const anonymousPoll = await (await call(environment, `/api/polls/${poll.id}`)).json()
  assert.equal(anonymousPoll.viewerParticipantId, undefined)

  await call(environment, `/api/polls/${poll.id}/responses`, {
    method: 'PUT',
    body: JSON.stringify({ participantId: publicParticipantId, name: 'Mallory', votes }),
  })
  await call(environment, `/api/polls/${poll.id}/responses`, {
    method: 'PUT',
    body: JSON.stringify({ participantId: editToken, name: 'Ada Updated', votes }),
  })

  const authenticatedPoll = await (await call(environment, `/api/polls/${poll.id}`, {
    headers: { 'X-Rally-Participant-Token': editToken },
  })).json()
  assert.equal(authenticatedPoll.viewerParticipantId, publicParticipantId)
  assert.deepEqual(
    authenticatedPoll.participants.map((participant) => participant.name).sort(),
    ['Ada Updated', 'Mallory'],
  )
})

test('includes the current response while KV key listings are stale', async () => {
  const environment = createEnvironment()
  const createResponse = await call(environment, '/api/polls', {
    method: 'POST',
    body: JSON.stringify(pollDraft(1)),
  })
  const poll = await createResponse.json()
  const saveResponse = await call(environment, `/api/polls/${poll.id}/responses`, {
    method: 'PUT',
    body: JSON.stringify({
      name: 'Ada',
      votes: { [poll.options[0].id]: 'yes' },
    }),
  })
  const saved = await saveResponse.json()
  environment.POLLS.list = async () => ({ keys: [], list_complete: true })

  const authenticatedPoll = await (await call(environment, `/api/polls/${poll.id}`, {
    headers: { 'X-Rally-Participant-Token': saved.participantId },
  })).json()

  assert.equal(authenticatedPoll.viewerParticipantId, saved.poll.viewerParticipantId)
  assert.deepEqual(authenticatedPoll.participants.map((participant) => participant.name), ['Ada'])
})

test('reuses an edit token when its KV value is temporarily stale', async () => {
  const environment = createEnvironment()
  const createResponse = await call(environment, '/api/polls', {
    method: 'POST',
    body: JSON.stringify(pollDraft(1)),
  })
  const poll = await createResponse.json()
  const votes = { [poll.options[0].id]: 'yes' }
  const firstSave = await call(environment, `/api/polls/${poll.id}/responses`, {
    method: 'PUT',
    body: JSON.stringify({ name: 'Ada', votes }),
  })
  const saved = await firstSave.json()
  const responseKeyName = [...environment.POLLS.values.keys()]
    .find((key) => key.startsWith(`response:${poll.id}:`))
  const originalGet = environment.POLLS.get.bind(environment.POLLS)
  let hideResponseValue = true
  environment.POLLS.get = async (key, type) => {
    if (hideResponseValue && key === responseKeyName) {
      hideResponseValue = false
      return null
    }
    return originalGet(key, type)
  }

  const secondSave = await call(environment, `/api/polls/${poll.id}/responses`, {
    method: 'PUT',
    body: JSON.stringify({ participantId: saved.participantId, name: 'Ada Updated', votes }),
  })
  const updated = await secondSave.json()

  assert.equal(updated.participantId, saved.participantId)
  assert.equal(updated.poll.viewerParticipantId, saved.poll.viewerParticipantId)
  assert.equal(
    [...environment.POLLS.values.keys()].filter((key) => key.startsWith(`response:${poll.id}:`)).length,
    1,
  )
})

test('does not persist a response when participant hydration fails', async () => {
  const environment = createEnvironment()
  const createResponse = await call(environment, '/api/polls', {
    method: 'POST',
    body: JSON.stringify(pollDraft(1)),
  })
  const poll = await createResponse.json()
  environment.POLLS.list = async () => { throw new Error('KV list failed') }
  const originalConsoleError = console.error
  console.error = () => undefined

  try {
    const response = await call(environment, `/api/polls/${poll.id}/responses`, {
      method: 'PUT',
      body: JSON.stringify({
        name: 'Ada',
        votes: { [poll.options[0].id]: 'yes' },
      }),
    })

    assert.equal(response.status, 500)
    assert.equal(
      [...environment.POLLS.values.keys()].filter((key) => key.startsWith(`response:${poll.id}:`)).length,
      0,
    )
  } finally {
    console.error = originalConsoleError
  }
})

test('enforces the configured response limit', async () => {
  const environment = createEnvironment({ MAX_POLL_RESPONSES: '1' })
  const createResponse = await call(environment, '/api/polls', {
    method: 'POST',
    body: JSON.stringify(pollDraft(1)),
  })
  const poll = await createResponse.json()
  const votes = { [poll.options[0].id]: 'yes' }

  await call(environment, `/api/polls/${poll.id}/responses`, {
    method: 'PUT',
    body: JSON.stringify({ name: 'Ada', votes }),
  })
  const response = await call(environment, `/api/polls/${poll.id}/responses`, {
    method: 'PUT',
    body: JSON.stringify({ name: 'Grace', votes }),
  })

  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: 'This poll has reached its response limit.' })
})

test('bounds KV scans when response metadata is malformed', async () => {
  const environment = createEnvironment({ MAX_POLL_RESPONSES: '2' })
  const createResponse = await call(environment, '/api/polls', {
    method: 'POST',
    body: JSON.stringify(pollDraft(1)),
  })
  const poll = await createResponse.json()
  let listCalls = 0
  environment.POLLS.list = async ({ limit }) => {
    listCalls += 1
    return {
      keys: Array.from({ length: limit }, (_, index) => ({
        name: `response:${poll.id}:invalid-${index}`,
        metadata: null,
      })),
      list_complete: false,
      cursor: `page-${listCalls}`,
    }
  }

  const response = await call(environment, `/api/polls/${poll.id}`)

  assert.equal(response.status, 200)
  assert.equal(listCalls, 1)
  assert.deepEqual((await response.json()).participants, [])
})

test('rejects impossible calendar dates', async () => {
  const environment = createEnvironment()
  const draft = pollDraft(1)
  draft.options[0].date = '2026-02-31'
  const response = await call(environment, '/api/polls', {
    method: 'POST',
    body: JSON.stringify(draft),
  })

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: 'Every option needs a valid date.' })
})

test('returns configuration and rejects unapproved browser origins', async () => {
  const environment = createEnvironment({ MAX_POLL_DATES: '20' })
  const configResponse = await call(environment, '/api/config')
  assert.deepEqual(await configResponse.json(), { maxDates: 20 })

  const rejectedResponse = await worker.fetch(
    new Request('https://rally-api.example/api/health', {
      headers: { Origin: 'https://example.com' },
    }),
    environment,
  )
  assert.equal(rejectedResponse.status, 403)
})