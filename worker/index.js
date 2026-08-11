const maxBodyBytes = 64 * 1024
const defaultMaxPollResponses = 100
const voteValues = ['yes', 'maybe', 'no']

class RequestError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

function coordinatorJson(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

function latestParticipants(participants) {
  const byId = new Map()
  for (const participant of participants) {
    if (!participant?.id) continue
    const existing = byId.get(participant.id)
    if (!existing || participant.updatedAt >= existing.updatedAt) {
      byId.set(participant.id, participant)
    }
  }
  return [...byId.values()]
}

function publicPoll(poll) {
  const { managementTokenHash: _managementTokenHash, participants: _participants, ...result } = poll
  return result
}

export class PollCoordinator {
  constructor(state) {
    this.state = state
  }

  async participants() {
    const entries = await this.state.storage.list({ prefix: 'participant:' })
    return latestParticipants([...entries.values()])
  }

  async mergeLegacyParticipants(participants) {
    const entries = {}
    for (const participant of participants.filter((item) => item?.id)) {
      const key = `participant:legacy:${participant.id}`
      const existing = await this.state.storage.get(key)
      if (!existing || participant.updatedAt > existing.updatedAt) entries[key] = participant
    }
    if (Object.keys(entries).length) await this.state.storage.put(entries)
  }

  async normalizeParticipants(optionIds) {
    const entries = await this.state.storage.list({ prefix: 'participant:' })
    const updates = Object.fromEntries([...entries].map(([key, participant]) => [key, {
      ...participant,
      votes: Object.fromEntries(optionIds.map((optionId) => [
        optionId,
        voteValues.includes(participant.votes?.[optionId]) ? participant.votes[optionId] : 'no',
      ])),
    }]))
    if (Object.keys(updates).length) await this.state.storage.put(updates)
  }

  async handle(request) {
    const url = new URL(request.url)
    const body = await request.json()
    if (await this.state.storage.get('poll:deleted')) {
      throw new RequestError('Poll not found.', 404)
    }

    if (request.method === 'DELETE' && url.pathname === '/poll') {
      const participantEntries = await this.state.storage.list({ prefix: 'participant:' })
      for (const key of participantEntries.keys()) await this.state.storage.delete(key)
      await this.state.storage.delete('poll:details')
      await this.state.storage.put('poll:deleted', true)
      return coordinatorJson({ deleted: true })
    }

    await this.mergeLegacyParticipants(Array.isArray(body.legacyParticipants)
      ? body.legacyParticipants
      : [])
    let poll = await this.state.storage.get('poll:details')
    if (!poll && body.legacyPoll?.id) {
      poll = body.legacyPoll
      await this.state.storage.put('poll:details', poll)
    }

    if (request.method === 'POST' && url.pathname === '/hydrate') {
      if (!poll) throw new RequestError('Poll not found.', 404)
      if (body.viewerParticipant && body.viewerTokenHash) {
        await this.state.storage.put(
          `participant:token:${body.viewerTokenHash}`,
          body.viewerParticipant,
        )
      }
      const viewerParticipant = body.viewerTokenHash
        ? await this.state.storage.get(`participant:token:${body.viewerTokenHash}`)
        : null
      return coordinatorJson({
        ...publicPoll(poll),
        participants: await this.participants(),
        ...(viewerParticipant ? { viewerParticipantId: viewerParticipant.id } : {}),
      })
    }

    if (request.method === 'PUT' && url.pathname === '/poll') {
      if (!body.poll?.id) throw new RequestError('Invalid poll.')
      poll = body.poll
      await this.state.storage.put('poll:details', poll)
      await this.normalizeParticipants(poll.options.map(({ id }) => id))
      return coordinatorJson({
        ...publicPoll(poll),
        participants: await this.participants(),
      })
    }

    if (request.method === 'PUT' && url.pathname === '/responses') {
      if (!poll) throw new RequestError('Poll not found.', 404)
      if (poll.status === 'closed') throw new RequestError('This poll is closed.', 409)
      const participant = body.participant
      const tokenHash = body.participantTokenHash
      const maxResponses = body.maxResponses
      if (!participant?.id || !/^[a-f0-9]{64}$/.test(tokenHash)) {
        throw new RequestError('Invalid participant response.')
      }

      const responseKeyName = `participant:token:${tokenHash}`
      const existingParticipant = await this.state.storage.get(responseKeyName)
      const participants = await this.participants()
      const participantExists = participants.some(({ id }) => id === participant.id)
      if (!existingParticipant && !participantExists && participants.length >= maxResponses) {
        throw new RequestError('This poll has reached its response limit.', 409)
      }

      await this.state.storage.put(responseKeyName, participant)
      await this.state.storage.delete(`participant:legacy:${participant.id}`)
      return coordinatorJson({
        participants: await this.participants(),
        viewerParticipantId: participant.id,
      })
    }

    throw new RequestError('Not found.', 404)
  }

  async fetch(request) {
    return this.state.blockConcurrencyWhile(async () => {
      try {
        return await this.handle(request)
      } catch (error) {
        if (error instanceof RequestError) {
          return coordinatorJson({ error: error.message }, error.status)
        }
        throw error
      }
    })
  }
}

function cleanText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function isValidDate(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1]
}

function parseMaxDates(value) {
  const normalizedValue = value?.trim().toLowerCase()
  if (!normalizedValue || ['0', 'none', 'unlimited'].includes(normalizedValue)) return null
  if (!/^\d+$/.test(normalizedValue) || Number(normalizedValue) < 1) {
    throw new Error('MAX_POLL_DATES must be a positive integer, 0, none, or unlimited.')
  }
  return Number(normalizedValue)
}

function parseMaxResponses(value) {
  const normalizedValue = value?.trim()
  if (!normalizedValue) return defaultMaxPollResponses
  if (!/^\d+$/.test(normalizedValue) || Number(normalizedValue) < 1) {
    throw new Error('MAX_POLL_RESPONSES must be a positive integer.')
  }
  return Number(normalizedValue)
}

function createId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(5)), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('')
}

function createParticipantToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('')
}

function pollKey(pollId) {
  return `poll:${pollId}`
}

function responsePrefix(pollId) {
  return `response:${pollId}:`
}

async function hashParticipantToken(participantToken) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(participantToken))
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('')
}

async function responseKey(pollId, participantToken) {
  const tokenHash = await hashParticipantToken(participantToken)
  return `${responsePrefix(pollId)}${tokenHash}`
}

function encodeVotes(poll, votes) {
  const bytes = new Uint8Array(Math.ceil(poll.options.length / 5))
  poll.options.forEach((option, index) => {
    const voteCode = Math.max(0, voteValues.indexOf(votes[option.id]))
    bytes[Math.floor(index / 5)] += voteCode * (3 ** (index % 5))
  })

  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function participantMetadata(poll, participant) {
  return {
    v: 1,
    i: participant.id,
    n: participant.name,
    r: encodeVotes(poll, participant.votes),
    u: participant.updatedAt,
  }
}

function participantFromMetadata(poll, metadata) {
  if (metadata?.v !== 1 || typeof metadata.r !== 'string') return null

  try {
    const binary = atob(metadata.r)
    if (binary.length < Math.ceil(poll.options.length / 5)) return null
    const votes = Object.fromEntries(poll.options.map((option, index) => {
      const byte = binary.charCodeAt(Math.floor(index / 5))
      const voteCode = Math.floor(byte / (3 ** (index % 5))) % 3
      return [option.id, voteValues[voteCode]]
    }))
    return {
      id: cleanText(metadata.i, 20),
      name: cleanText(metadata.n, 60),
      votes,
      updatedAt: cleanText(metadata.u, 30),
    }
  } catch {
    return null
  }
}

function validateOptions(options, maxDates) {
  if (!Array.isArray(options) || options.length === 0) {
    return 'Choose at least one date.'
  }

  if (maxDates !== null && options.length > maxDates) {
    return `Polls can include up to ${maxDates} dates.`
  }

  const uniqueDates = new Set()
  for (const option of options) {
    const date = cleanText(option?.date, 10)
    const time = cleanText(option?.time, 5)
    if (!isValidDate(date)) return 'Every option needs a valid date.'
    if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return 'Every time must be valid.'
    const key = `${date}-${time}`
    if (uniqueDates.has(key)) return 'Date options must be unique.'
    uniqueDates.add(key)
  }

  return null
}

function allowedOrigin(request, env) {
  const origin = request.headers.get('Origin')
  const configuredOrigins = cleanText(env.ALLOWED_ORIGINS, 2000)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)

  if (!origin || configuredOrigins.length === 0 || configuredOrigins.includes('*')) return '*'
  return configuredOrigins.includes(origin) ? origin : null
}

function responseHeaders(request, env) {
  const origin = allowedOrigin(request, env)
  return {
    'Access-Control-Allow-Headers': 'Content-Type, X-Rally-Participant-Token, X-Rally-Management-Token',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    Vary: 'Origin',
    ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
  }
}

function json(request, env, payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: responseHeaders(request, env),
  })
}

async function readJson(request) {
  const body = await request.arrayBuffer()
  if (body.byteLength > maxBodyBytes) throw new RequestError('Request body is too large.', 413)

  try {
    return JSON.parse(new TextDecoder().decode(body))
  } catch {
    throw new RequestError('Request body must be valid JSON.')
  }
}

async function readPoll(env, pollId) {
  return env.POLLS.get(pollKey(pollId), 'json')
}

async function readParticipants(env, poll, maxResponses) {
  const participants = []
  let scannedKeys = 0
  let cursor

  do {
    const remaining = maxResponses - scannedKeys
    if (remaining <= 0) break
    const page = await env.POLLS.list({
      prefix: responsePrefix(poll.id),
      limit: Math.min(remaining, 1000),
      ...(cursor ? { cursor } : {}),
    })
    scannedKeys += page.keys.length
    participants.push(...page.keys
      .map((key) => participantFromMetadata(poll, key.metadata))
      .filter(Boolean))
    if (page.list_complete) break
    cursor = page.cursor
  } while (cursor)

  return { participants, responseCount: scannedKeys }
}

function pollCoordinator(env, pollId) {
  if (!env.POLL_COORDINATORS) return null
  const objectId = env.POLL_COORDINATORS.idFromName(pollId)
  return env.POLL_COORDINATORS.get(objectId)
}

async function callPollCoordinator(env, pollId, path, method, payload) {
  const coordinator = pollCoordinator(env, pollId)
  if (!coordinator) return null
  const response = await coordinator.fetch(new Request(`https://poll-coordinator${path}`, {
    method,
    body: JSON.stringify(payload),
  }))
  const result = await response.json()
  if (!response.ok) throw new RequestError(result.error || 'Could not update this poll.', response.status)
  return result
}

function buildHydratedPoll(poll, participants, savedParticipant, viewerParticipantId) {
  if (savedParticipant) {
    const existingIndex = participants.findIndex((participant) => participant.id === savedParticipant.id)
    if (existingIndex >= 0) participants[existingIndex] = savedParticipant
    else participants.push(savedParticipant)
  }
  return {
    ...publicPoll(poll),
    participants,
    ...(viewerParticipantId ? { viewerParticipantId } : {}),
  }
}

async function hydratePoll(env, poll, savedParticipant, viewerTokenHash, maxResponses) {
  const { participants } = await readParticipants(env, poll, maxResponses)
  const coordinatedPoll = await callPollCoordinator(env, poll.id, '/hydrate', 'POST', {
    legacyPoll: poll,
    legacyParticipants: participants,
    viewerParticipant: savedParticipant,
    viewerTokenHash,
  })
  if (coordinatedPoll) return coordinatedPoll
  return buildHydratedPoll(poll, participants, savedParticipant, savedParticipant?.id)
}

async function authorizeManagement(request, poll) {
  const managementToken = cleanText(request.headers.get('X-Rally-Management-Token'), 64)
  const authorized = /^[a-f0-9]{48}$/.test(managementToken)
    && typeof poll.managementTokenHash === 'string'
    && await hashParticipantToken(managementToken) === poll.managementTokenHash
  if (!authorized) throw new RequestError('Organizer access required.', 403)
}

function updatedOptions(options, currentPoll, maxDates) {
  const optionsError = validateOptions(options, maxDates)
  if (optionsError) throw new RequestError(optionsError)

  const existingIds = new Set(currentPoll.options.map(({ id }) => id))
  const usedIds = new Set()
  return options.map((option) => {
    const requestedId = cleanText(option?.id, 20)
    const id = existingIds.has(requestedId) && !usedIds.has(requestedId)
      ? requestedId
      : createId()
    usedIds.add(id)
    return {
      id,
      date: cleanText(option.date, 10),
      time: cleanText(option.time, 5),
    }
  })
}

async function createPoll(request, env) {
  const body = await readJson(request)
  const title = cleanText(body.title, 100)
  const organizer = cleanText(body.organizer, 60)
  const optionsError = validateOptions(body.options, parseMaxDates(env.MAX_POLL_DATES))

  if (!title || !organizer || optionsError) {
    throw new RequestError(optionsError || 'A title and organizer name are required.')
  }

  const poll = {
    id: createId(),
    title,
    organizer,
    description: cleanText(body.description, 500),
    location: cleanText(body.location, 120),
    createdAt: new Date().toISOString(),
    status: 'open',
    options: body.options.map((option) => ({
      id: createId(),
      date: cleanText(option.date, 10),
      time: cleanText(option.time, 5),
    })),
  }

  const managementToken = createParticipantToken()
  poll.managementTokenHash = await hashParticipantToken(managementToken)

  await env.POLLS.put(pollKey(poll.id), JSON.stringify(poll))
  await callPollCoordinator(env, poll.id, '/poll', 'PUT', { poll, legacyParticipants: [] })
  return json(request, env, {
    ...publicPoll(poll),
    participants: [],
    managementToken,
  }, 201)
}

async function getPoll(request, env, pollId, maxResponses) {
  const poll = await readPoll(env, pollId)
  if (!poll) throw new RequestError('Poll not found.', 404)
  const participantToken = cleanText(request.headers.get('X-Rally-Participant-Token'), 64)
  const hasParticipantToken = /^[a-f0-9]{48}$/.test(participantToken)
  const viewerTokenHash = hasParticipantToken
    ? await hashParticipantToken(participantToken)
    : null
  const viewerParticipant = viewerTokenHash
    ? await env.POLLS.get(`${responsePrefix(pollId)}${viewerTokenHash}`, 'json')
    : null
  return json(request, env, await hydratePoll(
    env,
    poll,
    viewerParticipant,
    viewerTokenHash,
    maxResponses,
  ))
}

async function saveResponse(request, env, pollId, maxResponses) {
  const storedPoll = await readPoll(env, pollId)
  if (!storedPoll) throw new RequestError('Poll not found.', 404)

  const body = await readJson(request)
  const name = cleanText(body.name, 60)
  if (!name) throw new RequestError('Enter your name.')

  const requestedParticipantToken = cleanText(body.participantId, 64)
  const hasRequestedParticipantToken = /^[a-f0-9]{48}$/.test(requestedParticipantToken)
  const participantToken = hasRequestedParticipantToken
    ? requestedParticipantToken
    : createParticipantToken()
  const participantTokenHash = await hashParticipantToken(participantToken)
  const participantResponseKey = `${responsePrefix(pollId)}${participantTokenHash}`
  const existingParticipant = hasRequestedParticipantToken
    ? await env.POLLS.get(participantResponseKey, 'json')
    : null
  const poll = await hydratePoll(
    env,
    storedPoll,
    existingParticipant,
    hasRequestedParticipantToken ? participantTokenHash : null,
    maxResponses,
  )
  if (poll.status === 'closed') throw new RequestError('This poll is closed.', 409)
  const votes = Object.fromEntries(
    poll.options.map((option) => {
      const vote = body.votes?.[option.id]
      return [option.id, ['yes', 'maybe', 'no'].includes(vote) ? vote : 'no']
    }),
  )
  const participant = {
    id: existingParticipant?.id || participantTokenHash.slice(0, 10),
    name,
    votes,
    updatedAt: new Date().toISOString(),
  }

  const { participants, responseCount } = await readParticipants(env, poll, maxResponses)
  const coordinatedPoll = await callPollCoordinator(env, pollId, '/responses', 'PUT', {
    legacyPoll: storedPoll,
    legacyParticipants: participants,
    participant,
    participantTokenHash,
    maxResponses,
  })
  if (!coordinatedPoll && !existingParticipant && responseCount >= maxResponses) {
    throw new RequestError('This poll has reached its response limit.', 409)
  }

  await env.POLLS.put(
    participantResponseKey,
    JSON.stringify(participant),
    { metadata: participantMetadata(poll, participant) },
  )
  return json(request, env, {
    poll: coordinatedPoll
      ? { ...publicPoll(poll), ...coordinatedPoll }
      : buildHydratedPoll(poll, participants, participant, participant.id),
    participantId: participantToken,
  })
}

async function getManagedPoll(request, env, pollId, maxResponses) {
  const poll = await readPoll(env, pollId)
  if (!poll) throw new RequestError('Poll not found.', 404)
  await authorizeManagement(request, poll)
  return json(request, env, await hydratePoll(env, poll, null, null, maxResponses))
}

async function updatePoll(request, env, pollId, maxDates, maxResponses) {
  const storedPoll = await readPoll(env, pollId)
  if (!storedPoll) throw new RequestError('Poll not found.', 404)
  await authorizeManagement(request, storedPoll)
  const currentPoll = await hydratePoll(env, storedPoll, null, null, maxResponses)
  const body = await readJson(request)
  const title = body.title === undefined ? currentPoll.title : cleanText(body.title, 100)
  const organizer = body.organizer === undefined
    ? currentPoll.organizer
    : cleanText(body.organizer, 60)
  if (!title || !organizer) {
    throw new RequestError('A title and organizer name are required.')
  }
  if (body.status !== undefined && !['open', 'closed'].includes(body.status)) {
    throw new RequestError('Poll status must be open or closed.')
  }

  const poll = {
    ...storedPoll,
    title,
    organizer,
    description: body.description === undefined
      ? currentPoll.description
      : cleanText(body.description, 500),
    location: body.location === undefined
      ? currentPoll.location
      : cleanText(body.location, 120),
    status: body.status ?? currentPoll.status,
    options: body.options === undefined
      ? currentPoll.options
      : updatedOptions(body.options, currentPoll, maxDates),
  }
  const coordinatedPoll = await callPollCoordinator(env, pollId, '/poll', 'PUT', {
    poll,
    legacyParticipants: currentPoll.participants,
  })
  await env.POLLS.put(pollKey(pollId), JSON.stringify(poll))

  if (coordinatedPoll) return json(request, env, coordinatedPoll)
  const optionIds = new Set(poll.options.map(({ id }) => id))
  const participants = currentPoll.participants.map((participant) => ({
    ...participant,
    votes: Object.fromEntries([...optionIds].map((optionId) => [
      optionId,
      voteValues.includes(participant.votes[optionId]) ? participant.votes[optionId] : 'no',
    ])),
  }))
  return json(request, env, { ...publicPoll(poll), participants })
}

async function deletePoll(request, env, pollId, maxResponses) {
  const poll = await readPoll(env, pollId)
  if (!poll) throw new RequestError('Poll not found.', 404)
  await authorizeManagement(request, poll)
  await callPollCoordinator(env, pollId, '/poll', 'DELETE', {})
  const responsePage = await env.POLLS.list({
    prefix: responsePrefix(pollId),
    limit: maxResponses,
  })
  await Promise.all(responsePage.keys.map(({ name }) => env.POLLS.delete(name)))
  await env.POLLS.delete(pollKey(pollId))
  return json(request, env, { deleted: true })
}

async function route(request, env) {
  const url = new URL(request.url)
  const maxDates = parseMaxDates(env.MAX_POLL_DATES)
  const maxResponses = parseMaxResponses(env.MAX_POLL_RESPONSES)

  if (request.method === 'GET' && url.pathname === '/api/health') {
    return json(request, env, { status: 'ok' })
  }
  if (request.method === 'GET' && url.pathname === '/api/config') {
    return json(request, env, { maxDates })
  }
  if (request.method === 'POST' && url.pathname === '/api/polls') {
    return createPoll(request, env)
  }

  const pollMatch = url.pathname.match(/^\/api\/polls\/([a-f0-9]{10})$/)
  if (request.method === 'GET' && pollMatch) {
    return getPoll(request, env, pollMatch[1], maxResponses)
  }
  if (request.method === 'PATCH' && pollMatch) {
    return updatePoll(request, env, pollMatch[1], maxDates, maxResponses)
  }
  if (request.method === 'DELETE' && pollMatch) {
    return deletePoll(request, env, pollMatch[1], maxResponses)
  }

  const manageMatch = url.pathname.match(/^\/api\/polls\/([a-f0-9]{10})\/manage$/)
  if (request.method === 'GET' && manageMatch) {
    return getManagedPoll(request, env, manageMatch[1], maxResponses)
  }

  const responseMatch = url.pathname.match(/^\/api\/polls\/([a-f0-9]{10})\/responses$/)
  if (request.method === 'PUT' && responseMatch) {
    return saveResponse(request, env, responseMatch[1], maxResponses)
  }

  throw new RequestError('Not found.', 404)
}

export default {
  async fetch(request, env) {
    const origin = allowedOrigin(request, env)
    if (!origin) return json(request, env, { error: 'Origin not allowed.' }, 403)
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: responseHeaders(request, env) })
    }

    try {
      return await route(request, env)
    } catch (error) {
      if (error instanceof RequestError) {
        return json(request, env, { error: error.message }, error.status)
      }
      console.error(error)
      return json(request, env, { error: 'Something went wrong.' }, 500)
    }
  },
}