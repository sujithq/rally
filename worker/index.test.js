import assert from 'node:assert/strict'
import { pbkdf2Sync } from 'node:crypto'
import test from 'node:test'
import worker, { AccountCoordinator, PollCoordinator } from './index.js'

class MemoryDurableStorage {
  values = new Map()
  alarmAt = null

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

  async list({ prefix = '', startAfter = '', limit = Number.POSITIVE_INFINITY } = {}) {
    return new Map([...this.values]
      .filter(([key]) => key.startsWith(prefix) && (!startAfter || key > startAfter))
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, limit))
  }

  async setAlarm(alarmAt) {
    this.alarmAt = alarmAt
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

  constructor(Coordinator, getEnvironment) {
    this.Coordinator = Coordinator
    this.getEnvironment = getEnvironment
  }

  idFromName(name) {
    return name
  }

  get(id) {
    if (!this.coordinators.has(id)) {
      this.coordinators.set(id, new this.Coordinator(
        new MemoryDurableState(),
        this.getEnvironment?.(),
      ))
    }
    return {
      fetch: (request) => this.coordinators.get(id).fetch(request),
    }
  }
}

class MemoryKv {
  values = new Map()
  metadata = new Map()
  subrequestCount = 0
  subrequestLimit = Number.POSITIVE_INFINITY

  consumeSubrequest() {
    this.subrequestCount += 1
    if (this.subrequestCount > this.subrequestLimit) {
      throw new Error(`KV subrequest limit exceeded: ${this.subrequestLimit}`)
    }
  }

  resetSubrequests(limit = Number.POSITIVE_INFINITY) {
    this.subrequestCount = 0
    this.subrequestLimit = limit
  }

  async get(key, type) {
    this.consumeSubrequest()
    const value = this.values.get(key)
    if (value === undefined) return null
    return type === 'json' ? JSON.parse(value) : value
  }

  async put(key, value, options = {}) {
    this.consumeSubrequest()
    this.values.set(key, value)
    if (options.metadata) this.metadata.set(key, options.metadata)
  }

  async delete(key) {
    this.consumeSubrequest()
    this.values.delete(key)
    this.metadata.delete(key)
  }

  async list({ prefix, limit = 1000 }) {
    this.consumeSubrequest()
    const keys = [...this.values.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort()
      .slice(0, limit)
      .map((name) => ({ name, metadata: this.metadata.get(name) }))
    return { keys, list_complete: true }
  }
}

function createEnvironment(overrides = {}) {
  const environment = {
    POLLS: new MemoryKv(),
    MAX_POLL_DATES: 'unlimited',
    MAX_POLL_RESPONSES: '100',
    ALLOWED_ORIGINS: 'https://quintelier.dev',
    ...overrides,
  }
  environment.POLL_COORDINATORS ||= new MemoryDurableNamespace(
    PollCoordinator,
    () => environment,
  )
  environment.ACCOUNT_COORDINATORS ||= new MemoryDurableNamespace(
    AccountCoordinator,
    () => environment,
  )
  return environment
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

test('supports account-owned and claimed polls without storing plaintext passwords', async () => {
  const environment = createEnvironment()
  const password = 'correct horse battery staple'
  const registrationResponse = await call(environment, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Ada', email: 'ADA@example.com', password }),
  })
  assert.equal(registrationResponse.status, 201)
  const registration = await registrationResponse.json()
  assert.equal(registration.user.email, 'ada@example.com')
  assert.match(registration.token, /^[a-f0-9]{64}\.[a-f0-9]{64}$/)

  const [accountKey, sessionSecret] = registration.token.split('.')
  const accountCoordinator = environment.ACCOUNT_COORDINATORS.coordinators.get(accountKey)
  const storedAccount = await accountCoordinator.state.storage.get('account')
  const storedAuthentication = JSON.stringify([...accountCoordinator.state.storage.values.entries()])
  assert.equal(storedAuthentication.includes(password), false)
  assert.equal(storedAuthentication.includes(sessionSecret), false)
  assert.equal(storedAccount.password, undefined)
  assert.equal(storedAccount.passwordHash.algorithm, 'pbkdf2-sha256')
  assert.equal(storedAccount.passwordHash.iterations, 100_000)
  assert.equal(
    [...accountCoordinator.state.storage.values.keys()].some((key) => key.includes(registration.token)),
    false,
  )

  const loginResponse = await call(environment, '/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'ada@example.com', password }),
  })
  assert.equal(loginResponse.status, 200)
  const login = await loginResponse.json()
  assert.equal(login.user.email, 'ada@example.com')
  assert.match(login.token, /^[a-f0-9]{64}\.[a-f0-9]{64}$/)

  const authorization = { Authorization: `Bearer ${registration.token}` }
  const created = await (await call(environment, '/api/polls', {
    method: 'POST',
    headers: authorization,
    body: JSON.stringify(pollDraft(1)),
  })).json()
  assert.equal(created.ownerId, undefined)
  assert.equal(created.ownerKey, undefined)
  assert.equal((await call(environment, `/api/polls/${created.id}/manage`, {
    headers: authorization,
  })).status, 200)

  const anonymous = await (await call(environment, '/api/polls', {
    method: 'POST',
    body: JSON.stringify(pollDraft(1)),
  })).json()
  const claimResponse = await call(environment, '/api/account/polls/claim', {
    method: 'POST',
    headers: {
      ...authorization,
      'X-Rally-Management-Token': anonymous.managementToken,
    },
    body: JSON.stringify({ pollId: anonymous.id }),
  })
  assert.equal(claimResponse.status, 200)
  assert.equal((await call(environment, `/api/polls/${anonymous.id}/manage`, {
    headers: { 'X-Rally-Management-Token': anonymous.managementToken },
  })).status, 200)

  assert.equal((await call(environment, `/api/polls/${created.id}/responses`, {
    method: 'PUT',
    body: JSON.stringify({
      name: 'Grace',
      votes: { [created.options[0].id]: 'yes' },
    }),
  })).status, 200)

  const ownedPolls = await (await call(environment, '/api/account/polls', {
    headers: authorization,
  })).json()
  assert.deepEqual(ownedPolls.polls.map(({ id }) => id).sort(), [anonymous.id, created.id].sort())
  const createdSummary = ownedPolls.polls.find(({ id }) => id === created.id)
  assert.equal(createdSummary.participantCount, 1)
  assert.deepEqual(createdSummary.participants, [])

  const wrongPassword = await call(environment, '/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'ada@example.com', password: 'not the password' }),
  })
  assert.equal(wrongPassword.status, 401)
  assert.equal((await call(environment, '/api/auth/session', { headers: authorization })).status, 200)
  assert.equal((await call(environment, '/api/auth/session', {
    method: 'DELETE',
    headers: authorization,
  })).status, 200)
  assert.equal((await call(environment, '/api/auth/session', { headers: authorization })).status, 401)
  assert.equal((await call(environment, '/api/polls', {
    method: 'POST',
    headers: authorization,
    body: JSON.stringify(pollDraft(1)),
  })).status, 401)
})

test('rejects password records above the Worker PBKDF2 limit', async () => {
  const environment = createEnvironment()
  const password = 'correct horse battery staple'
  const registrationResponse = await call(environment, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Ada', email: 'ada@example.com', password }),
  })
  assert.equal(registrationResponse.status, 201)
  const registration = await registrationResponse.json()

  const [accountKey] = registration.token.split('.')
  const accountCoordinator = environment.ACCOUNT_COORDINATORS.coordinators.get(accountKey)
  const storedAccount = await accountCoordinator.state.storage.get('account')
  const iterations = 100_001
  await accountCoordinator.state.storage.put('account', {
    ...storedAccount,
    passwordHash: {
      ...storedAccount.passwordHash,
      iterations,
      hash: pbkdf2Sync(
        password,
        Buffer.from(storedAccount.passwordHash.salt, 'hex'),
        iterations,
        32,
        'sha256',
      ).toString('hex'),
    },
  })

  const loginResponse = await call(environment, '/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'ada@example.com', password }),
  })
  assert.equal(loginResponse.status, 401)
  assert.deepEqual(await loginResponse.json(), { error: 'Email or password is incorrect.' })
})

test('imports KV-era responses after an account claim is authorized', async () => {
  const environment = createEnvironment()
  const poll = await (await call(environment, '/api/polls', {
    method: 'POST',
    body: JSON.stringify(pollDraft(1)),
  })).json()
  assert.equal((await call(environment, `/api/polls/${poll.id}/responses`, {
    method: 'PUT',
    body: JSON.stringify({
      name: 'Grace',
      votes: { [poll.options[0].id]: 'yes' },
    }),
  })).status, 200)
  environment.POLL_COORDINATORS.coordinators.delete(poll.id)

  const registration = await (await call(environment, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Ada',
      email: 'ada@example.com',
      password: 'correct horse battery staple',
    }),
  })).json()
  const authorization = { Authorization: `Bearer ${registration.token}` }
  const claimedPoll = await (await call(environment, '/api/account/polls/claim', {
    method: 'POST',
    headers: {
      ...authorization,
      'X-Rally-Management-Token': poll.managementToken,
    },
    body: JSON.stringify({ pollId: poll.id }),
  })).json()
  assert.deepEqual(claimedPoll.participants.map(({ name }) => name), ['Grace'])

  const ownedPolls = await (await call(environment, '/api/account/polls', {
    headers: authorization,
  })).json()
  assert.equal(ownedPolls.polls[0].participantCount, 1)
})

test('paginates account poll summaries in bounded Worker invocations', async () => {
  const environment = createEnvironment()
  const registration = await (await call(environment, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Ada',
      email: 'ada@example.com',
      password: 'correct horse battery staple',
    }),
  })).json()
  const [accountKey] = registration.token.split('.')
  const accountCoordinator = environment.ACCOUNT_COORDINATORS.coordinators.get(accountKey)
  const pollIds = Array.from({ length: 51 }, (_, index) => index.toString(16).padStart(10, '0'))
  for (const [index, id] of pollIds.entries()) {
    const poll = {
      id,
      title: `Poll ${index}`,
      organizer: 'Ada',
      description: '',
      location: '',
      createdAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
      status: 'open',
      options: [{ id: '0000000000', date: '2026-08-10', time: '' }],
      managementTokenHash: '0'.repeat(64),
      ownerId: registration.user.id,
      ownerKey: accountKey,
    }
    await accountCoordinator.state.storage.put(`poll:${id}`, { id, createdAt: poll.createdAt })
    environment.POLL_COORDINATORS.get(id)
    await environment.POLL_COORDINATORS.coordinators
      .get(id).state.storage.put('poll:details', poll)
  }
  const headers = { Authorization: `Bearer ${registration.token}` }
  environment.POLLS.resetSubrequests(0)

  const firstPage = await (await call(environment, '/api/account/polls', { headers })).json()
  assert.equal(firstPage.polls.length, 50)
  assert.equal(firstPage.nextCursor, pollIds[49])
  const secondPage = await (await call(
    environment,
    `/api/account/polls?cursor=${firstPage.nextCursor}`,
    { headers },
  )).json()
  assert.deepEqual(secondPage.polls.map(({ id }) => id), [pollIds[50]])
  assert.equal(secondPage.nextCursor, undefined)
  assert.equal(environment.POLLS.subrequestCount, 0)
})

test('prunes expired and oldest Worker account sessions', async () => {
  const state = new MemoryDurableState()
  const coordinator = new AccountCoordinator(state)
  const account = { id: '0'.repeat(20), email: 'ada@example.com', name: 'Ada' }
  const now = Date.now()
  await state.storage.put('account', account)
  await state.storage.put('session:expired', {
    accountId: account.id,
    createdAt: new Date(now - 20_000).toISOString(),
    expiresAt: new Date(now - 1_000).toISOString(),
  })
  for (let index = 0; index < 11; index += 1) {
    await state.storage.put(`session:active-${index}`, {
      accountId: account.id,
      createdAt: new Date(now - (11 - index) * 1_000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
    })
  }

  const token = await coordinator.createSession('a'.repeat(64), account.id)
  const sessions = await state.storage.list({ prefix: 'session:' })
  assert.equal(sessions.size, 10)
  assert.equal(sessions.has('session:expired'), false)
  assert.equal(sessions.has('session:active-0'), false)
  assert.equal(sessions.has('session:active-1'), false)
  assert.deepEqual(await coordinator.sessionAccount(token.split('.')[1]), account)
})

test('allows only one account to claim an anonymous poll concurrently', async () => {
  const environment = createEnvironment()
  const registrations = await Promise.all(['ada', 'grace'].map(async (name) => {
    const response = await call(environment, '/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        name,
        email: `${name}@example.com`,
        password: 'correct horse battery staple',
      }),
    })
    return response.json()
  }))
  const anonymous = await (await call(environment, '/api/polls', {
    method: 'POST',
    body: JSON.stringify(pollDraft(1)),
  })).json()

  const claims = await Promise.all(registrations.map(({ token }) => call(
    environment,
    '/api/account/polls/claim',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Rally-Management-Token': anonymous.managementToken,
      },
      body: JSON.stringify({ pollId: anonymous.id }),
    },
  )))

  assert.deepEqual(claims.map(({ status }) => status).sort(), [200, 409])
  const winningIndex = claims.findIndex(({ status }) => status === 200)
  const stalePoll = await environment.POLLS.get(`poll:${anonymous.id}`, 'json')
  delete stalePoll.ownerId
  delete stalePoll.ownerKey
  await environment.POLLS.put(`poll:${anonymous.id}`, JSON.stringify(stalePoll))
  assert.equal((await call(environment, `/api/polls/${anonymous.id}`, {
    method: 'PATCH',
    headers: { 'X-Rally-Management-Token': anonymous.managementToken },
    body: JSON.stringify({ title: 'Updated after claim' }),
  })).status, 200)
  const repairedPoll = await environment.POLLS.get(`poll:${anonymous.id}`, 'json')
  assert.equal(repairedPoll.ownerId, registrations[winningIndex].user.id)

  const managementStatuses = await Promise.all(registrations.map(({ token }) => call(
    environment,
    `/api/polls/${anonymous.id}/manage`,
    { headers: { Authorization: `Bearer ${token}` } },
  )))
  assert.equal(managementStatuses[winningIndex].status, 200)
  assert.equal(managementStatuses[1 - winningIndex].status, 403)
})

test('returns a manageable poll when account indexing fails during creation', async () => {
  const environment = createEnvironment()
  const registration = await (await call(environment, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Ada',
      email: 'ada@example.com',
      password: 'correct horse battery staple',
    }),
  })).json()
  const accountCoordinators = environment.ACCOUNT_COORDINATORS
  environment.ACCOUNT_COORDINATORS = {
    idFromName: (name) => accountCoordinators.idFromName(name),
    get: (id) => {
      const coordinator = accountCoordinators.get(id)
      return {
        fetch: (request) => request.method === 'PUT'
          && new URL(request.url).pathname === '/polls/reconcile'
          ? new Response(JSON.stringify({ error: 'Index unavailable.' }), { status: 503 })
          : coordinator.fetch(request),
      }
    },
  }
  const originalConsoleError = console.error
  console.error = () => undefined

  try {
    const creationResponse = await call(environment, '/api/polls', {
      method: 'POST',
      headers: { Authorization: `Bearer ${registration.token}` },
      body: JSON.stringify(pollDraft(1)),
    })
    assert.equal(creationResponse.status, 201)
    const poll = await creationResponse.json()
    assert.match(poll.managementToken, /^[a-f0-9]{48}$/)
    assert.equal((await call(environment, `/api/polls/${poll.id}/manage`, {
      headers: { 'X-Rally-Management-Token': poll.managementToken },
    })).status, 200)
    const pollCoordinator = environment.POLL_COORDINATORS.coordinators.get(poll.id)
    assert.ok(await pollCoordinator.state.storage.get('poll:ownership-sync'))
    assert.ok(pollCoordinator.state.storage.alarmAt)
    assert.equal((await call(environment, `/api/polls/${poll.id}`, {
      method: 'PATCH',
      headers: { 'X-Rally-Management-Token': poll.managementToken },
      body: JSON.stringify({ title: 'Edited while indexing is unavailable' }),
    })).status, 200)
    assert.equal(
      (await pollCoordinator.state.storage.get('poll:ownership-sync')).poll.title,
      'Edited while indexing is unavailable',
    )

    environment.ACCOUNT_COORDINATORS = accountCoordinators
    await pollCoordinator.alarm()
    assert.equal(await pollCoordinator.state.storage.get('poll:ownership-sync'), undefined)
    assert.equal(
      (await environment.POLLS.get(`poll:${poll.id}`, 'json')).title,
      'Edited while indexing is unavailable',
    )
    const ownedPolls = await (await call(environment, '/api/account/polls', {
      headers: { Authorization: `Bearer ${registration.token}` },
    })).json()
    assert.deepEqual(ownedPolls.polls.map(({ id }) => id), [poll.id])
  } finally {
    environment.ACCOUNT_COORDINATORS = accountCoordinators
    console.error = originalConsoleError
  }
})

test('retries account cleanup without resurrecting a deleted poll', async () => {
  const environment = createEnvironment()
  const registration = await (await call(environment, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Ada',
      email: 'ada@example.com',
      password: 'correct horse battery staple',
    }),
  })).json()
  const poll = await (await call(environment, '/api/polls', {
    method: 'POST',
    headers: { Authorization: `Bearer ${registration.token}` },
    body: JSON.stringify(pollDraft(1)),
  })).json()
  const accountCoordinators = environment.ACCOUNT_COORDINATORS
  environment.ACCOUNT_COORDINATORS = {
    idFromName: (name) => accountCoordinators.idFromName(name),
    get: (id) => {
      const coordinator = accountCoordinators.get(id)
      return {
        fetch: (request) => request.method === 'DELETE'
          && new URL(request.url).pathname === '/polls/reconcile'
          ? new Response(JSON.stringify({ error: 'Index unavailable.' }), { status: 503 })
          : coordinator.fetch(request),
      }
    },
  }
  const originalConsoleError = console.error
  console.error = () => undefined

  try {
    assert.equal((await call(environment, `/api/polls/${poll.id}`, {
      method: 'DELETE',
      headers: { 'X-Rally-Management-Token': poll.managementToken },
    })).status, 200)
    assert.equal((await call(environment, `/api/polls/${poll.id}`)).status, 404)
    const pollCoordinator = environment.POLL_COORDINATORS.coordinators.get(poll.id)
    assert.ok(await pollCoordinator.state.storage.get('poll:deletion-sync'))
    assert.equal(await pollCoordinator.state.storage.get('poll:ownership-sync'), undefined)
    assert.ok(pollCoordinator.state.storage.alarmAt)
    const staleOwnedPolls = await (await call(environment, '/api/account/polls', {
      headers: { Authorization: `Bearer ${registration.token}` },
    })).json()
    assert.deepEqual(staleOwnedPolls.polls, [])

    environment.ACCOUNT_COORDINATORS = accountCoordinators
    await pollCoordinator.alarm()
    assert.ok(await pollCoordinator.state.storage.get('poll:deletion-sync'))
    await pollCoordinator.alarm()
    assert.equal(await pollCoordinator.state.storage.get('poll:deletion-sync'), undefined)
    assert.equal(await environment.POLLS.get(`poll:${poll.id}`, 'json'), null)
    const ownedPolls = await (await call(environment, '/api/account/polls', {
      headers: { Authorization: `Bearer ${registration.token}` },
    })).json()
    assert.deepEqual(ownedPolls.polls, [])
  } finally {
    environment.ACCOUNT_COORDINATORS = accountCoordinators
    console.error = originalConsoleError
  }
})

test('serializes poll mirror writes before deletion', async () => {
  const environment = createEnvironment()
  const poll = await (await call(environment, '/api/polls', {
    method: 'POST',
    body: JSON.stringify(pollDraft(1)),
  })).json()
  const originalPut = environment.POLLS.put.bind(environment.POLLS)
  let releaseMirror
  const mirrorReleased = new Promise((resolve) => { releaseMirror = resolve })
  let markMirrorStarted
  const mirrorStarted = new Promise((resolve) => { markMirrorStarted = resolve })
  environment.POLLS.put = async (key, value, options) => {
    if (key === `poll:${poll.id}` && JSON.parse(value).title === 'Delayed update') {
      markMirrorStarted()
      await mirrorReleased
    }
    return originalPut(key, value, options)
  }

  const update = call(environment, `/api/polls/${poll.id}`, {
    method: 'PATCH',
    headers: { 'X-Rally-Management-Token': poll.managementToken },
    body: JSON.stringify({ title: 'Delayed update' }),
  })
  await mirrorStarted
  let deletionSettled = false
  const deletion = call(environment, `/api/polls/${poll.id}`, {
    method: 'DELETE',
    headers: { 'X-Rally-Management-Token': poll.managementToken },
  }).then((response) => {
    deletionSettled = true
    return response
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(deletionSettled, false)

  releaseMirror()
  assert.equal((await update).status, 200)
  assert.equal((await deletion).status, 200)
  assert.equal(await environment.POLLS.get(`poll:${poll.id}`, 'json'), null)
})

test('serializes response mirror writes before deletion', async () => {
  const environment = createEnvironment()
  const poll = await (await call(environment, '/api/polls', {
    method: 'POST',
    body: JSON.stringify(pollDraft(1)),
  })).json()
  const originalPut = environment.POLLS.put.bind(environment.POLLS)
  let releaseMirror
  const mirrorReleased = new Promise((resolve) => { releaseMirror = resolve })
  let markMirrorStarted
  const mirrorStarted = new Promise((resolve) => { markMirrorStarted = resolve })
  environment.POLLS.put = async (key, value, options) => {
    if (key.startsWith(`response:${poll.id}:`)) {
      markMirrorStarted()
      await mirrorReleased
    }
    return originalPut(key, value, options)
  }

  const responseWrite = call(environment, `/api/polls/${poll.id}/responses`, {
    method: 'PUT',
    body: JSON.stringify({
      name: 'Ada',
      votes: { [poll.options[0].id]: 'yes' },
    }),
  })
  await mirrorStarted
  let deletionSettled = false
  const deletion = call(environment, `/api/polls/${poll.id}`, {
    method: 'DELETE',
    headers: { 'X-Rally-Management-Token': poll.managementToken },
  }).then((response) => {
    deletionSettled = true
    return response
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(deletionSettled, false)

  releaseMirror()
  assert.equal((await responseWrite).status, 200)
  assert.equal((await deletion).status, 200)
  const responses = await environment.POLLS.list({ prefix: `response:${poll.id}:` })
  assert.deepEqual(responses.keys, [])
})

test('drains paginated response mirrors before clearing a deletion tombstone', async () => {
  const environment = createEnvironment()
  const poll = await (await call(environment, '/api/polls', {
    method: 'POST',
    body: JSON.stringify(pollDraft(1)),
  })).json()
  await Promise.all(Array.from({ length: 1001 }, (_, index) => environment.POLLS.put(
    `response:${poll.id}:${String(index).padStart(4, '0')}`,
    JSON.stringify({ id: String(index) }),
  )))
  environment.POLLS.resetSubrequests(1000)

  assert.equal((await call(environment, `/api/polls/${poll.id}`, {
    method: 'DELETE',
    headers: { 'X-Rally-Management-Token': poll.managementToken },
  })).status, 200)
  const pollCoordinator = environment.POLL_COORDINATORS.coordinators.get(poll.id)
  assert.equal((await environment.POLLS.list({
    prefix: `response:${poll.id}:`,
    limit: 2000,
  })).keys.length, 101)
  assert.ok(environment.POLLS.subrequestCount <= 1000)
  assert.equal(
    (await pollCoordinator.state.storage.get('poll:deletion-sync')).verificationPending,
    false,
  )

  environment.POLLS.resetSubrequests(1000)
  await pollCoordinator.alarm()
  assert.ok(await pollCoordinator.state.storage.get('poll:deletion-sync'))
  assert.deepEqual((await environment.POLLS.list({ prefix: `response:${poll.id}:` })).keys, [])
  assert.ok(environment.POLLS.subrequestCount <= 1000)
  environment.POLLS.resetSubrequests(1000)
  await pollCoordinator.alarm()
  assert.equal(await pollCoordinator.state.storage.get('poll:deletion-sync'), undefined)
})

test('keeps organizer-token access available when the account service fails', async () => {
  const environment = createEnvironment()
  const poll = await (await call(environment, '/api/polls', {
    method: 'POST',
    body: JSON.stringify(pollDraft(1)),
  })).json()
  environment.ACCOUNT_COORDINATORS = {
    idFromName: (name) => name,
    get: () => ({ fetch: () => new Response('{}', { status: 503 }) }),
  }

  assert.equal((await call(environment, `/api/polls/${poll.id}/manage`, {
    headers: { 'X-Rally-Management-Token': poll.managementToken },
  })).status, 200)
})

test('throttles repeated Worker sign-in attempts', async () => {
  const environment = createEnvironment()
  await call(environment, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Ada',
      email: 'ada@example.com',
      password: 'correct horse battery staple',
    }),
  })

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await call(environment, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'ada@example.com', password: 'incorrect password' }),
    })
    assert.equal(response.status, 401)
  }
  assert.equal((await call(environment, '/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({
      email: 'ada@example.com',
      password: 'correct horse battery staple',
    }),
  })).status, 429)

  const rotatingEnvironment = createEnvironment()
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await call(rotatingEnvironment, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'invalid', password: 'incorrect password' }),
    })
    assert.equal(response.status, 401)
  }
  assert.equal((await call(rotatingEnvironment, '/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'invalid', password: 'incorrect password' }),
  })).status, 429)
})

test('throttles Worker account registration before creating another account', async () => {
  const environment = createEnvironment()
  const statuses = []
  for (let attempt = 0; attempt < 11; attempt += 1) {
    const response = await call(environment, '/api/auth/register', {
      method: 'POST',
      headers: { 'CF-Connecting-IP': '203.0.113.10' },
      body: JSON.stringify({
        name: `Organizer ${attempt}`,
        email: `organizer-${attempt}@example.com`,
        password: 'correct horse battery staple',
      }),
    })
    statuses.push(response.status)
  }

  assert.deepEqual(statuses, [...Array(10).fill(201), 429])
  assert.equal(environment.ACCOUNT_COORDINATORS.coordinators.size, 11)
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
  assert.match(preflightResponse.headers.get('Access-Control-Allow-Headers'), /Authorization/)

  const rejectedResponse = await worker.fetch(
    new Request('https://rally-api.example/api/health', {
      headers: { Origin: 'https://example.com' },
    }),
    environment,
  )
  assert.equal(rejectedResponse.status, 403)
})