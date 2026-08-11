import assert from 'node:assert/strict'
import test from 'node:test'
import worker, { PollCoordinator } from './index.js'

class MemoryDurableStorage {
  values = new Map()

  async get(key) {
    return this.values.get(key)
  }

  async put(key, value) {
    if (typeof key === 'string') {
      this.values.set(key, value)
      return
    }
    for (const [entryKey, entryValue] of Object.entries(key)) {
      this.values.set(entryKey, entryValue)
    }
  }

  async delete(key) {
    return this.values.delete(key)
  }

  async list({ prefix }) {
    return new Map([...this.values]
      .filter(([key]) => key.startsWith(prefix))
      .sort(([left], [right]) => left.localeCompare(right)))
  }
}

class MemoryDurableState {
  storage = new MemoryDurableStorage()
  tail = Promise.resolve()

  blockConcurrencyWhile(callback) {
    const result = this.tail.then(callback, callback)
    this.tail = result.catch(() => undefined)
    return result
  }
}

class MemoryDurableNamespace {
  coordinators = new Map()

  idFromName(name) {
    return name
  }

  get(id) {
    if (!this.coordinators.has(id)) {
      this.coordinators.set(id, new PollCoordinator(new MemoryDurableState()))
    }
    return {
      fetch: (request) => this.coordinators.get(id).fetch(request),
    }
  }
}

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

  async delete(key) {
    this.values.delete(key)
    this.metadata.delete(key)
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
    POLL_COORDINATORS: new MemoryDurableNamespace(),
    MAX_POLL_DATES: 'unlimited',
    MAX_POLL_RESPONSES: '100',
    ALLOWED_ORIGINS: 'https://quintelier.dev',
    ...overrides,
  }
}

function call(environment, path, options = {}) {
  const headers = new Headers(options.headers)
  headers.set('Origin', 'https://quintelier.dev')
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

test('coordinates concurrent participant responses with strongly consistent storage', async () => {
  const coordinator = new PollCoordinator(new MemoryDurableState())
  await coordinator.fetch(new Request('https://coordinator/poll', {
    method: 'PUT',
    body: JSON.stringify({
      poll: { id: 'poll-one', status: 'open', options: [] },
      legacyParticipants: [],
    }),
  }))
  const participants = [
    { id: 'participant-one', name: 'Ada', votes: {}, updatedAt: '2026-08-11T00:00:00.000Z' },
    { id: 'participant-two', name: 'Grace', votes: {}, updatedAt: '2026-08-11T00:00:01.000Z' },
  ]

  const responses = await Promise.all(participants.map((participant, index) => coordinator.fetch(
    new Request('https://coordinator/responses', {
      method: 'PUT',
      body: JSON.stringify({
        legacyParticipants: [],
        participant,
        participantTokenHash: String(index + 1).repeat(64),
        maxResponses: 100,
      }),
    }),
  )))

  assert.deepEqual(responses.map(({ status }) => status), [200, 200])
  const hydrated = await coordinator.fetch(new Request('https://coordinator/hydrate', {
    method: 'POST',
    body: JSON.stringify({ legacyParticipants: [] }),
  }))
  assert.deepEqual(
    (await hydrated.json()).participants.map(({ name }) => name).sort(),
    ['Ada', 'Grace'],
  )
})

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

test('protects poll management and supports the organizer lifecycle', async () => {
  const environment = createEnvironment()
  const created = await (await call(environment, '/api/polls', {
    method: 'POST',
    body: JSON.stringify(pollDraft(1)),
  })).json()

  assert.match(created.managementToken, /^[a-f0-9]{48}$/)
  assert.equal(created.managementTokenHash, undefined)
  const publicPoll = await (await call(environment, `/api/polls/${created.id}`)).json()
  assert.equal(publicPoll.managementToken, undefined)
  assert.equal(publicPoll.managementTokenHash, undefined)

  const unauthorized = await call(environment, `/api/polls/${created.id}/manage`)
  assert.equal(unauthorized.status, 403)

  const managementHeaders = { 'X-Rally-Management-Token': created.managementToken }
  const votes = { [created.options[0].id]: 'yes' }
  await call(environment, `/api/polls/${created.id}/responses`, {
    method: 'PUT',
    body: JSON.stringify({ name: 'Grace', votes }),
  })
  const updateResponse = await call(environment, `/api/polls/${created.id}`, {
    method: 'PATCH',
    headers: managementHeaders,
    body: JSON.stringify({
      title: 'Updated planning session',
      status: 'closed',
      options: [
        { ...created.options[0], date: '2026-08-20' },
        { date: '2026-08-21', time: '09:30' },
      ],
    }),
  })

  assert.equal(updateResponse.status, 200)
  const updated = await updateResponse.json()
  assert.equal(updated.title, 'Updated planning session')
  assert.equal(updated.status, 'closed')
  assert.equal(updated.options.length, 2)
  assert.equal(updated.participants[0].votes[updated.options[1].id], 'no')

  const closedResponse = await call(environment, `/api/polls/${created.id}/responses`, {
    method: 'PUT',
    body: JSON.stringify({ name: 'Ada', votes }),
  })
  assert.equal(closedResponse.status, 409)

  const reopened = await call(environment, `/api/polls/${created.id}`, {
    method: 'PATCH',
    headers: managementHeaders,
    body: JSON.stringify({ status: 'open' }),
  })
  assert.equal(reopened.status, 200)

  const managed = await call(environment, `/api/polls/${created.id}/manage`, {
    headers: managementHeaders,
  })
  assert.equal(managed.status, 200)

  const deleted = await call(environment, `/api/polls/${created.id}`, {
    method: 'DELETE',
    headers: managementHeaders,
  })
  assert.equal(deleted.status, 200)
  assert.equal((await call(environment, `/api/polls/${created.id}`)).status, 404)
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

test('shares updates across sessions while KV key listings are stale', async () => {
  const environment = createEnvironment()
  const createResponse = await call(environment, '/api/polls', {
    method: 'POST',
    body: JSON.stringify(pollDraft(1)),
  })
  const poll = await createResponse.json()
  environment.POLLS.list = async () => ({ keys: [], list_complete: true })
  const votes = { [poll.options[0].id]: 'yes' }

  const firstSaved = await (await call(environment, `/api/polls/${poll.id}/responses`, {
    method: 'PUT',
    body: JSON.stringify({ name: 'Ada', votes }),
  })).json()
  const secondSaved = await (await call(environment, `/api/polls/${poll.id}/responses`, {
    method: 'PUT',
    body: JSON.stringify({ name: 'Grace', votes }),
  })).json()

  const firstView = await (await call(environment, `/api/polls/${poll.id}`, {
    headers: { 'X-Rally-Participant-Token': firstSaved.participantId },
  })).json()
  assert.deepEqual(firstView.participants.map(({ name }) => name).sort(), ['Ada', 'Grace'])

  await call(environment, `/api/polls/${poll.id}/responses`, {
    method: 'PUT',
    body: JSON.stringify({
      participantId: firstSaved.participantId,
      name: 'Ada Updated',
      votes,
    }),
  })
  const secondView = await (await call(environment, `/api/polls/${poll.id}`, {
    headers: { 'X-Rally-Participant-Token': secondSaved.participantId },
  })).json()
  assert.deepEqual(secondView.participants.map(({ name }) => name).sort(), ['Ada Updated', 'Grace'])
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

test('returns configuration, management CORS methods, and rejects unapproved origins', async () => {
  const environment = createEnvironment({ MAX_POLL_DATES: '20' })
  const configResponse = await call(environment, '/api/config')
  assert.deepEqual(await configResponse.json(), { maxDates: 20 })

  const preflightResponse = await call(environment, '/api/polls/poll-one', { method: 'OPTIONS' })
  assert.equal(preflightResponse.status, 204)
  assert.equal(
    preflightResponse.headers.get('Access-Control-Allow-Methods'),
    'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  )

  const rejectedResponse = await worker.fetch(
    new Request('https://rally-api.example/api/health', {
      headers: { Origin: 'https://example.com' },
    }),
    environment,
  )
  assert.equal(rejectedResponse.status, 403)
})