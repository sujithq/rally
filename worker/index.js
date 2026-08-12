const maxBodyBytes = 64 * 1024
const defaultMaxPollResponses = 100
const voteValues = ['yes', 'maybe', 'no']
const passwordIterations = 100_000
const sessionLifetimeMs = 30 * 24 * 60 * 60 * 1000
const maxActiveSessions = 10
const failedLoginWindowMs = 15 * 60 * 1000
const loginLockMs = 15 * 60 * 1000
const maxFailedLoginAttempts = 5
const loginRateWindowMs = 10 * 60 * 1000
const maxLoginAttemptsPerIp = 30
const registrationRateWindowMs = 60 * 60 * 1000
const maxRegistrationAttemptsPerIp = 10
const deletionPageLimit = 900
const deletionRetryMs = 60 * 1000
const accountPollPageSize = 50

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
  const {
    managementTokenHash: _managementTokenHash,
    ownerId: _ownerId,
    ownerKey: _ownerKey,
    participants: _participants,
    ...result
  } = poll
  return result
}

export class PollCoordinator {
  constructor(state, env) {
    this.state = state
    this.env = env
  }

  async reconcileOwnership() {
    const pending = await this.state.storage.get('poll:ownership-sync')
    if (!pending) return
    if (!this.env?.POLLS || !this.env?.ACCOUNT_COORDINATORS) {
      throw new Error('Poll ownership mirrors are unavailable.')
    }

    await this.env.POLLS.put(pollKey(pending.poll.id), JSON.stringify(pending.poll))
    const response = await this.env.ACCOUNT_COORDINATORS
      .get(this.env.ACCOUNT_COORDINATORS.idFromName(pending.poll.ownerKey))
      .fetch(new Request('https://account-coordinator/polls/reconcile', {
        method: 'PUT',
        body: JSON.stringify({
          ownerId: pending.poll.ownerId,
          poll: { id: pending.poll.id, createdAt: pending.poll.createdAt },
        }),
      }))
    if (!response.ok) throw new Error('Could not reconcile the account poll index.')
    await this.state.storage.delete('poll:ownership-sync')
  }

  async reconcileDeletion() {
    const pending = await this.state.storage.get('poll:deletion-sync')
    if (!pending) return false
    if (!this.env?.POLLS) throw new Error('Poll deletion mirrors are unavailable.')

    const responsePage = await this.env.POLLS.list({
      prefix: responsePrefix(pending.pollId),
      limit: deletionPageLimit,
    })
    await Promise.all(responsePage.keys.map(({ name }) => this.env.POLLS.delete(name)))
    await this.env.POLLS.delete(pollKey(pending.pollId))
    if (pending.ownerKey) {
      if (!this.env.ACCOUNT_COORDINATORS) {
        throw new Error('Account deletion mirror is unavailable.')
      }
      const response = await this.env.ACCOUNT_COORDINATORS
        .get(this.env.ACCOUNT_COORDINATORS.idFromName(pending.ownerKey))
        .fetch(new Request('https://account-coordinator/polls/reconcile', {
          method: 'DELETE',
          body: JSON.stringify({
            ownerId: pending.ownerId,
            pollId: pending.pollId,
          }),
        }))
      if (!response.ok) throw new Error('Could not reconcile the account poll deletion.')
    }

    const hasMoreResponses = responsePage.list_complete === false
      || responsePage.keys.length >= deletionPageLimit
    if (responsePage.keys.length || hasMoreResponses || !pending.verificationPending) {
      await this.state.storage.put('poll:deletion-sync', {
        ...pending,
        verificationPending: !hasMoreResponses,
      })
      if (typeof this.state.storage.setAlarm === 'function') {
        await this.state.storage.setAlarm(Date.now() + (hasMoreResponses ? 1_000 : deletionRetryMs))
      }
      return true
    }
    await this.state.storage.delete('poll:deletion-sync')
    return true
  }

  async reconcileMirrors() {
    if (await this.reconcileDeletion()) {
      await this.state.storage.delete('poll:ownership-sync')
      return
    }
    if (await this.state.storage.get('poll:deleted')) {
      await this.state.storage.delete('poll:ownership-sync')
      return
    }
    await this.reconcileOwnership()
  }

  async tryReconcileMirrors() {
    try {
      await this.reconcileMirrors()
    } catch (error) {
      console.error('Could not reconcile poll mirrors.', error)
      if (typeof this.state.storage.setAlarm === 'function') {
        await this.state.storage.setAlarm(Date.now() + 60_000)
      }
    }
  }

  async alarm() {
    return this.state.blockConcurrencyWhile(() => this.tryReconcileMirrors())
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
      const poll = await this.state.storage.get('poll:details')
      const participantEntries = await this.state.storage.list({ prefix: 'participant:' })
      for (const key of participantEntries.keys()) await this.state.storage.delete(key)
      await this.state.storage.delete('poll:details')
      await this.state.storage.put({
        'poll:deleted': true,
        'poll:deletion-sync': {
          pollId: poll?.id || body.pollId,
          ownerId: poll?.ownerId,
          ownerKey: poll?.ownerKey,
        },
      })
      await this.state.storage.delete('poll:ownership-sync')
      await this.tryReconcileMirrors()
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

    if (request.method === 'POST' && url.pathname === '/details') {
      if (!poll) throw new RequestError('Poll not found.', 404)
      return coordinatorJson({ poll })
    }

    if (request.method === 'POST' && url.pathname === '/summary') {
      if (!poll) throw new RequestError('Poll not found.', 404)
      return coordinatorJson({
        poll: {
          ...publicPoll(poll),
          participants: [],
          participantCount: (await this.participants()).length,
        },
      })
    }

    if (request.method === 'POST' && url.pathname === '/claim') {
      if (!poll) throw new RequestError('Poll not found.', 404)
      if (!/^[a-f0-9]{20}$/.test(body.ownerId || '')
        || !/^[a-f0-9]{64}$/.test(body.ownerKey || '')) {
        throw new RequestError('Invalid account details.')
      }
      if (poll.ownerId && poll.ownerId !== body.ownerId) {
        throw new RequestError('This poll already belongs to another account.', 409)
      }
      if (!poll.ownerId) {
        if (!/^[a-f0-9]{64}$/.test(body.managementTokenHash || '')
          || body.managementTokenHash !== poll.managementTokenHash) {
          throw new RequestError('Organizer access required.', 403)
        }
        poll = { ...poll, ownerId: body.ownerId, ownerKey: body.ownerKey }
        await this.state.storage.put({
          'poll:details': poll,
          'poll:ownership-sync': { poll },
        })
      }
      if (await this.state.storage.get('poll:ownership-sync')) {
        await this.tryReconcileMirrors()
      }
      return coordinatorJson({ poll })
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
      const previousPoll = poll
      poll = previousPoll ? {
        ...body.poll,
        id: previousPoll.id,
        createdAt: previousPoll.createdAt,
        managementTokenHash: previousPoll.managementTokenHash,
        ...(previousPoll.ownerId ? {
          ownerId: previousPoll.ownerId,
          ownerKey: previousPoll.ownerKey,
        } : {}),
      } : body.poll
      await this.state.storage.put('poll:details', poll)
      if (this.env?.POLLS) {
        await this.env.POLLS.put(pollKey(poll.id), JSON.stringify(poll))
      }
      const ownershipSyncPending = poll.ownerId
        ? await this.state.storage.get('poll:ownership-sync')
        : null
      if (poll.ownerId && (!previousPoll?.ownerId || ownershipSyncPending)) {
        await this.state.storage.put('poll:ownership-sync', { poll })
        await this.tryReconcileMirrors()
      }
      await this.normalizeParticipants(poll.options.map(({ id }) => id))
      return coordinatorJson({
        poll,
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
      if (this.env?.POLLS) {
        await this.env.POLLS.put(
          `${responsePrefix(poll.id)}${tokenHash}`,
          JSON.stringify(participant),
          { metadata: participantMetadata(poll, participant) },
        )
      }
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

export class AccountCoordinator {
  constructor(state) {
    this.state = state
  }

  async createSession(accountKey, accountId) {
    const sessionSecret = createSessionSecret()
    const now = Date.now()
    const sessions = await this.state.storage.list({ prefix: 'session:' })
    const activeSessions = []
    for (const [key, session] of sessions) {
      if (session?.accountId !== accountId || !(Date.parse(session.expiresAt) > now)) {
        await this.state.storage.delete(key)
      } else {
        activeSessions.push([key, session])
      }
    }
    activeSessions.sort(([, left], [, right]) => (
      Date.parse(left.createdAt) - Date.parse(right.createdAt)
    ))
    const excessCount = Math.max(0, activeSessions.length - maxActiveSessions + 1)
    for (const [key] of activeSessions.slice(0, excessCount)) {
      await this.state.storage.delete(key)
    }
    await this.state.storage.put(`session:${await hashParticipantToken(sessionSecret)}`, {
      accountId,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + sessionLifetimeMs).toISOString(),
    })
    return `${accountKey}.${sessionSecret}`
  }

  async sessionAccount(sessionSecret) {
    if (!/^[a-f0-9]{64}$/.test(sessionSecret || '')) return null
    const key = `session:${await hashParticipantToken(sessionSecret)}`
    const session = await this.state.storage.get(key)
    if (!session || !(Date.parse(session.expiresAt) > Date.now())) {
      if (session) await this.state.storage.delete(key)
      return null
    }
    const account = await this.state.storage.get('account')
    return account?.id === session.accountId ? account : null
  }

  async handle(request) {
    const url = new URL(request.url)
    const body = await request.json()

    if (request.method === 'POST' && url.pathname === '/login/rate') {
      const now = Date.now()
      const current = await this.state.storage.get('login:rate')
      const active = current && Date.parse(current.resetAt) > now
      if (active && current.count >= maxLoginAttemptsPerIp) {
        throw new RequestError('Too many sign-in attempts. Try again later.', 429)
      }
      await this.state.storage.put('login:rate', {
        count: active ? current.count + 1 : 1,
        resetAt: active
          ? current.resetAt
          : new Date(now + loginRateWindowMs).toISOString(),
      })
      return coordinatorJson({ allowed: true })
    }

    if (request.method === 'POST' && url.pathname === '/register/rate') {
      const now = Date.now()
      const current = await this.state.storage.get('register:rate')
      const active = current && Date.parse(current.resetAt) > now
      if (active && current.count >= maxRegistrationAttemptsPerIp) {
        throw new RequestError('Too many account registrations. Try again later.', 429)
      }
      await this.state.storage.put('register:rate', {
        count: active ? current.count + 1 : 1,
        resetAt: active
          ? current.resetAt
          : new Date(now + registrationRateWindowMs).toISOString(),
      })
      return coordinatorJson({ allowed: true })
    }

    if (request.method === 'POST' && url.pathname === '/register') {
      if (await this.state.storage.get('account')) {
        throw new RequestError('An account with that email already exists.', 409)
      }
      if (await hashParticipantToken(body.email) !== body.accountKey) {
        throw new RequestError('Invalid account details.')
      }
      const account = {
        id: `${createId()}${createId()}`,
        email: body.email,
        name: body.name,
        passwordHash: await passwordRecord(body.password),
        createdAt: new Date().toISOString(),
      }
      await this.state.storage.put('account', account)
      return coordinatorJson({
        user: publicAccount(account),
        token: await this.createSession(body.accountKey, account.id),
      }, 201)
    }

    if (request.method === 'POST' && url.pathname === '/login') {
      const now = Date.now()
      const currentFailure = await this.state.storage.get('login:failures')
      if (currentFailure && Date.parse(currentFailure.blockedUntil) > now) {
        throw new RequestError('Too many sign-in attempts. Try again later.', 429)
      }
      const account = await this.state.storage.get('account')
      const matches = account
        ? await passwordMatches(body.password, account.passwordHash)
        : await passwordMatches(body.password, dummyPasswordRecord)
      if (!account || !matches) {
        const active = currentFailure
          && Date.parse(currentFailure.firstAttemptAt) > now - failedLoginWindowMs
        const count = active ? currentFailure.count + 1 : 1
        await this.state.storage.put('login:failures', {
          count,
          firstAttemptAt: active
            ? currentFailure.firstAttemptAt
            : new Date(now).toISOString(),
          ...(count >= maxFailedLoginAttempts
            ? { blockedUntil: new Date(now + loginLockMs).toISOString() }
            : {}),
        })
        throw new RequestError('Email or password is incorrect.', 401)
      }
      await this.state.storage.delete('login:failures')
      return coordinatorJson({
        user: publicAccount(account),
        token: await this.createSession(body.accountKey, account.id),
      })
    }

    if (request.method === 'POST' && url.pathname === '/session') {
      const account = await this.sessionAccount(body.sessionSecret)
      if (!account) throw new RequestError('Sign in required.', 401)
      return coordinatorJson({ account: publicAccount(account) })
    }

    if (request.method === 'DELETE' && url.pathname === '/session') {
      if (/^[a-f0-9]{64}$/.test(body.sessionSecret || '')) {
        await this.state.storage.delete(`session:${await hashParticipantToken(body.sessionSecret)}`)
      }
      return coordinatorJson({ signedOut: true })
    }

    if (request.method === 'POST' && url.pathname === '/polls/list') {
      const account = await this.sessionAccount(body.sessionSecret)
      if (!account) throw new RequestError('Sign in required.', 401)
      if (body.cursor && !/^[a-f0-9]{10}$/.test(body.cursor)) {
        throw new RequestError('Invalid poll cursor.')
      }
      const entries = await this.state.storage.list({
        prefix: 'poll:',
        limit: accountPollPageSize + 1,
        ...(body.cursor ? { startAfter: `poll:${body.cursor}` } : {}),
      })
      const page = [...entries.entries()]
      const visibleEntries = page.slice(0, accountPollPageSize)
      const nextCursor = page.length > accountPollPageSize
        ? visibleEntries.at(-1)?.[0].slice('poll:'.length)
        : undefined
      return coordinatorJson({
        polls: visibleEntries.map(([, poll]) => poll),
        ...(nextCursor ? { nextCursor } : {}),
      })
    }

    if (request.method === 'PUT' && url.pathname === '/polls') {
      const account = await this.sessionAccount(body.sessionSecret)
      if (!account) throw new RequestError('Sign in required.', 401)
      if (!body.poll?.id) throw new RequestError('Invalid poll.')
      await this.state.storage.put(`poll:${body.poll.id}`, body.poll)
      return coordinatorJson({ saved: true })
    }

    if (request.method === 'PUT' && url.pathname === '/polls/reconcile') {
      const account = await this.state.storage.get('account')
      if (!account || account.id !== body.ownerId || !body.poll?.id) {
        throw new RequestError('Invalid poll ownership.', 403)
      }
      await this.state.storage.put(`poll:${body.poll.id}`, body.poll)
      return coordinatorJson({ saved: true })
    }

    if (request.method === 'DELETE' && url.pathname === '/polls/reconcile') {
      const account = await this.state.storage.get('account')
      if (!account || account.id !== body.ownerId || !body.pollId) {
        throw new RequestError('Invalid poll ownership.', 403)
      }
      await this.state.storage.delete(`poll:${body.pollId}`)
      return coordinatorJson({ deleted: true })
    }

    if (request.method === 'DELETE' && url.pathname === '/polls') {
      await this.state.storage.delete(`poll:${body.pollId}`)
      return coordinatorJson({ deleted: true })
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

function createSessionSecret() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (value) =>
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

function bytesFromHex(value) {
  return new Uint8Array(value.match(/.{2}/g).map((byte) => Number.parseInt(byte, 16)))
}

async function derivePasswordHash(password, salt, iterations = passwordIterations) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const digest = await crypto.subtle.deriveBits({
    name: 'PBKDF2',
    hash: 'SHA-256',
    salt: bytesFromHex(salt),
    iterations,
  }, key, 256)
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('')
}

async function passwordRecord(password) {
  const salt = Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('')
  return {
    algorithm: 'pbkdf2-sha256',
    iterations: passwordIterations,
    salt,
    hash: await derivePasswordHash(password, salt),
  }
}

function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return difference === 0
}

async function passwordMatches(password, record) {
  if (record?.algorithm !== 'pbkdf2-sha256'
    || !Number.isSafeInteger(record.iterations)
    || record.iterations > passwordIterations
    || !/^[a-f0-9]{32}$/.test(record.salt || '')
    || !/^[a-f0-9]{64}$/.test(record.hash || '')) return false
  return constantTimeEqual(
    await derivePasswordHash(password, record.salt, record.iterations),
    record.hash,
  )
}

const dummyPasswordRecord = {
  algorithm: 'pbkdf2-sha256',
  iterations: passwordIterations,
  salt: '00000000000000000000000000000000',
  hash: '0000000000000000000000000000000000000000000000000000000000000000',
}

function normalizeEmail(value) {
  return cleanText(value, 254).toLowerCase()
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function publicAccount(account) {
  return { id: account.id, email: account.email, name: account.name }
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
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Rally-Participant-Token, X-Rally-Management-Token',
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
  try {
    const coordinated = await callPollCoordinator(env, pollId, '/details', 'POST', {
      legacyParticipants: [],
    })
    if (coordinated) return coordinated.poll
  } catch (error) {
    if (!(error instanceof RequestError && error.status === 404)) throw error
  }

  const legacyPoll = await env.POLLS.get(pollKey(pollId), 'json')
  if (!legacyPoll) return null
  const coordinated = await callPollCoordinator(env, pollId, '/details', 'POST', {
    legacyPoll,
    legacyParticipants: [],
  })
  return coordinated?.poll || legacyPoll
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

function accountCoordinator(env, accountKey) {
  if (!env.ACCOUNT_COORDINATORS) {
    throw new RequestError('Account service is unavailable.', 503)
  }
  const objectId = env.ACCOUNT_COORDINATORS.idFromName(accountKey)
  return env.ACCOUNT_COORDINATORS.get(objectId)
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

async function callAccountCoordinator(env, accountKey, path, method, payload) {
  const response = await accountCoordinator(env, accountKey).fetch(
    new Request(`https://account-coordinator${path}`, {
      method,
      body: JSON.stringify(payload),
    }),
  )
  const result = await response.json()
  if (!response.ok) throw new RequestError(result.error || 'Could not access this account.', response.status)
  return result
}

function requestSession(request) {
  const authorization = cleanText(request.headers.get('Authorization'), 160)
  const match = /^Bearer ([a-f0-9]{64})\.([a-f0-9]{64})$/i.exec(authorization)
  return match ? { accountKey: match[1].toLowerCase(), sessionSecret: match[2].toLowerCase() } : null
}

async function authenticatedAccount(request, env) {
  const session = requestSession(request)
  if (!session) return null
  try {
    const { account } = await callAccountCoordinator(
      env,
      session.accountKey,
      '/session',
      'POST',
      { sessionSecret: session.sessionSecret },
    )
    return { ...session, account }
  } catch (error) {
    if (error instanceof RequestError && error.status === 401) return null
    throw error
  }
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

async function authorizeManagement(request, env, poll) {
  const managementToken = cleanText(request.headers.get('X-Rally-Management-Token'), 64)
  const tokenAuthorized = /^[a-f0-9]{48}$/.test(managementToken)
    && typeof poll.managementTokenHash === 'string'
    && await hashParticipantToken(managementToken) === poll.managementTokenHash
  if (tokenAuthorized) return

  const authentication = poll.ownerId ? await authenticatedAccount(request, env) : null
  if (!authentication || authentication.account.id !== poll.ownerId) {
    throw new RequestError('Organizer access required.', 403)
  }
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

  const authentication = await authenticatedAccount(request, env)
  if (request.headers.has('Authorization') && !authentication) {
    throw new RequestError('Sign in required.', 401)
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
    ...(authentication ? {
      ownerId: authentication.account.id,
      ownerKey: authentication.accountKey,
    } : {}),
  }

  const managementToken = createParticipantToken()
  poll.managementTokenHash = await hashParticipantToken(managementToken)

  const coordinatedPoll = await callPollCoordinator(
    env,
    poll.id,
    '/poll',
    'PUT',
    { poll, legacyParticipants: [] },
  )
  if (!coordinatedPoll) await env.POLLS.put(pollKey(poll.id), JSON.stringify(poll))
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

  if (!coordinatedPoll) {
    await env.POLLS.put(
      participantResponseKey,
      JSON.stringify(participant),
      { metadata: participantMetadata(poll, participant) },
    )
  }
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
  await authorizeManagement(request, env, poll)
  return json(request, env, await hydratePoll(env, poll, null, null, maxResponses))
}

async function updatePoll(request, env, pollId, maxDates, maxResponses) {
  const storedPoll = await readPoll(env, pollId)
  if (!storedPoll) throw new RequestError('Poll not found.', 404)
  await authorizeManagement(request, env, storedPoll)
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
  const persistedPoll = coordinatedPoll?.poll || poll
  if (!coordinatedPoll) await env.POLLS.put(pollKey(pollId), JSON.stringify(persistedPoll))

  if (coordinatedPoll) {
    return json(request, env, {
      ...publicPoll(persistedPoll),
      participants: coordinatedPoll.participants,
    })
  }
  const optionIds = new Set(poll.options.map(({ id }) => id))
  const participants = currentPoll.participants.map((participant) => ({
    ...participant,
    votes: Object.fromEntries([...optionIds].map((optionId) => [
      optionId,
      voteValues.includes(participant.votes[optionId]) ? participant.votes[optionId] : 'no',
    ])),
  }))
  return json(request, env, { ...publicPoll(persistedPoll), participants })
}

async function deletePoll(request, env, pollId) {
  const poll = await readPoll(env, pollId)
  if (!poll) throw new RequestError('Poll not found.', 404)
  await authorizeManagement(request, env, poll)
  await callPollCoordinator(env, pollId, '/poll', 'DELETE', { pollId })
  return json(request, env, { deleted: true })
}

async function registerAccount(request, env) {
  const body = await readJson(request)
  const email = normalizeEmail(body.email)
  const name = cleanText(body.name, 60)
  const password = typeof body.password === 'string' ? body.password : ''
  if (!validEmail(email) || !name || password.length < 10 || password.length > 128) {
    throw new RequestError('Enter a name, a valid email, and a password of 10 to 128 characters.')
  }
  const clientIp = cleanText(request.headers.get('CF-Connecting-IP'), 128) || 'unknown'
  const rateKey = await hashParticipantToken(`register:${clientIp}`)
  await callAccountCoordinator(env, rateKey, '/register/rate', 'POST', {})
  const accountKey = await hashParticipantToken(email)
  const result = await callAccountCoordinator(env, accountKey, '/register', 'POST', {
    accountKey,
    email,
    name,
    password,
  })
  return json(request, env, result, 201)
}

async function loginAccount(request, env) {
  const body = await readJson(request)
  const email = normalizeEmail(body.email)
  const password = typeof body.password === 'string' ? body.password : ''
  const clientIp = cleanText(request.headers.get('CF-Connecting-IP'), 128) || 'unknown'
  const rateKey = await hashParticipantToken(`login:${clientIp}`)
  await callAccountCoordinator(env, rateKey, '/login/rate', 'POST', {})
  if (!validEmail(email) || !password || password.length > 128) {
    throw new RequestError('Email or password is incorrect.', 401)
  }
  const accountKey = await hashParticipantToken(email)
  const result = await callAccountCoordinator(env, accountKey, '/login', 'POST', {
    accountKey,
    password,
  })
  return json(request, env, result)
}

async function getAccountSession(request, env) {
  const authentication = await authenticatedAccount(request, env)
  if (!authentication) throw new RequestError('Sign in required.', 401)
  return json(request, env, { user: authentication.account })
}

async function logoutAccount(request, env) {
  const session = requestSession(request)
  if (session) {
    await callAccountCoordinator(env, session.accountKey, '/session', 'DELETE', {
      sessionSecret: session.sessionSecret,
    })
  }
  return json(request, env, { signedOut: true })
}

async function getAccountPolls(request, env) {
  const authentication = await authenticatedAccount(request, env)
  if (!authentication) throw new RequestError('Sign in required.', 401)
  const cursor = cleanText(new URL(request.url).searchParams.get('cursor'), 20)
  if (cursor && !/^[a-f0-9]{10}$/.test(cursor)) {
    throw new RequestError('Invalid poll cursor.')
  }
  const { polls: references, nextCursor } = await callAccountCoordinator(
    env,
    authentication.accountKey,
    '/polls/list',
    'POST',
    { sessionSecret: authentication.sessionSecret, cursor },
  )
  const polls = (await Promise.all(references.map(async ({ id }) => {
    try {
      const summary = await callPollCoordinator(env, id, '/summary', 'POST', {
        legacyParticipants: [],
      })
      return summary?.poll || null
    } catch (error) {
      if (error instanceof RequestError && error.status === 404) return null
      throw error
    }
  }))).filter(Boolean)
  return json(request, env, {
    polls,
    ...(nextCursor ? { nextCursor } : {}),
  })
}

async function claimAccountPoll(request, env, maxResponses) {
  const authentication = await authenticatedAccount(request, env)
  if (!authentication) throw new RequestError('Sign in required.', 401)
  const body = await readJson(request)
  const pollId = cleanText(body.pollId, 20)
  const poll = await readPoll(env, pollId)
  if (!poll) throw new RequestError('Poll not found.', 404)
  const managementToken = cleanText(request.headers.get('X-Rally-Management-Token'), 64)
  const coordinatedClaim = await callPollCoordinator(env, pollId, '/claim', 'POST', {
    legacyPoll: poll,
    legacyParticipants: [],
    ownerId: authentication.account.id,
    ownerKey: authentication.accountKey,
    managementTokenHash: /^[a-f0-9]{48}$/.test(managementToken)
      ? await hashParticipantToken(managementToken)
      : '',
  })
  if (!coordinatedClaim) throw new RequestError('Poll ownership service is unavailable.', 503)
  const claimedPoll = coordinatedClaim.poll
  return json(request, env, await hydratePoll(env, claimedPoll, null, null, maxResponses))
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
  if (request.method === 'POST' && url.pathname === '/api/auth/register') {
    return registerAccount(request, env)
  }
  if (request.method === 'POST' && url.pathname === '/api/auth/login') {
    return loginAccount(request, env)
  }
  if (request.method === 'GET' && url.pathname === '/api/auth/session') {
    return getAccountSession(request, env)
  }
  if (request.method === 'DELETE' && url.pathname === '/api/auth/session') {
    return logoutAccount(request, env)
  }
  if (request.method === 'GET' && url.pathname === '/api/account/polls') {
    return getAccountPolls(request, env)
  }
  if (request.method === 'POST' && url.pathname === '/api/account/polls/claim') {
    return claimAccountPoll(request, env, maxResponses)
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
    return deletePoll(request, env, pollMatch[1])
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