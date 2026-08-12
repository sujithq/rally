import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { validateConfig } from '../scripts/validate-config.mjs'

const modulePath = fileURLToPath(import.meta.url)
const __dirname = path.dirname(modulePath)
const rootDirectory = path.resolve(__dirname, '..')
const dataDirectory = path.join(rootDirectory, 'data')
const instanceConfig = validateConfig(
  process.env.RALLY_CONFIG_FILE
    ? path.resolve(process.env.RALLY_CONFIG_FILE)
    : path.join(rootDirectory, 'rally.config.json'),
)
const dataFile = process.env.RALLY_DATA_FILE
  ? path.resolve(process.env.RALLY_DATA_FILE)
  : path.join(dataDirectory, 'polls.json')
const authDataFile = process.env.RALLY_AUTH_DATA_FILE
  ? path.resolve(process.env.RALLY_AUTH_DATA_FILE)
  : path.join(dataDirectory, 'auth.json')
const distDirectory = path.join(rootDirectory, 'dist')
const port = Number(process.env.PORT) || 4174
const passwordIterations = 310_000
const sessionLifetimeMs = 30 * 24 * 60 * 60 * 1000
const maxActiveSessions = 10
const failedLoginWindowMs = 15 * 60 * 1000
const loginLockMs = 15 * 60 * 1000
const maxFailedLoginAttempts = 5
const loginRateWindowMs = 10 * 60 * 1000
const maxLoginAttemptsPerIp = 30
const registrationRateWindowMs = 60 * 60 * 1000
const maxRegistrationAttemptsPerIp = 10
const maxRateLimitBuckets = 10_000
const rateLimitSweepIntervalMs = 60 * 1000
const failedLoginAttempts = new Map()
const loginAttemptsByIp = new Map()
const registrationAttemptsByIp = new Map()
const loginQueues = new Map()
const rateLimitSweepTimes = new WeakMap()

const maxPollDates = instanceConfig.polls.maxDates
const maxPollResponses = instanceConfig.polls.maxResponses
const app = express()

app.use(express.json({ limit: '64kb' }))

async function readPolls() {
  try {
    return JSON.parse(await fs.readFile(dataFile, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

let writeQueue = Promise.resolve()

function updatePolls(updater) {
  const update = writeQueue.then(async () => {
    const polls = await readPolls()
    const result = updater(polls)
    await fs.mkdir(path.dirname(dataFile), { recursive: true })
    await fs.writeFile(dataFile, JSON.stringify(polls, null, 2))
    return result
  })

  writeQueue = update.catch(() => undefined)
  return update
}

async function readAuthData() {
  try {
    const data = JSON.parse(await fs.readFile(authDataFile, 'utf8'))
    return {
      accounts: Array.isArray(data.accounts) ? data.accounts : [],
      sessions: Array.isArray(data.sessions) ? data.sessions : [],
    }
  } catch (error) {
    if (error.code === 'ENOENT') return { accounts: [], sessions: [] }
    throw error
  }
}

let authWriteQueue = Promise.resolve()

async function writeAuthData(data) {
  await fs.mkdir(path.dirname(authDataFile), { recursive: true })
  const temporaryFile = `${authDataFile}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  let handle
  try {
    handle = await fs.open(temporaryFile, 'wx', 0o600)
    await handle.writeFile(JSON.stringify(data, null, 2), 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await fs.rename(temporaryFile, authDataFile)
  } finally {
    if (handle) await handle.close().catch(() => undefined)
    await fs.rm(temporaryFile, { force: true }).catch(() => undefined)
  }
}

function updateAuthData(updater) {
  const update = authWriteQueue.then(async () => {
    const data = await readAuthData()
    const result = await updater(data)
    await writeAuthData(data)
    return result
  })

  authWriteQueue = update.catch(() => undefined)
  return update
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

function hashParticipantToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
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

function derivePasswordHash(password, salt, iterations = passwordIterations) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, Buffer.from(salt, 'hex'), iterations, 32, 'sha256', (error, hash) => {
      if (error) reject(error)
      else resolve(hash.toString('hex'))
    })
  })
}

async function passwordRecord(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  return {
    algorithm: 'pbkdf2-sha256',
    iterations: passwordIterations,
    salt,
    hash: await derivePasswordHash(password, salt),
  }
}

async function passwordMatches(password, record) {
  if (record?.algorithm !== 'pbkdf2-sha256'
    || !Number.isSafeInteger(record.iterations)
    || !/^[a-f0-9]{32}$/.test(record.salt || '')
    || !/^[a-f0-9]{64}$/.test(record.hash || '')) return false
  const candidate = await derivePasswordHash(password, record.salt, record.iterations)
  return crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(record.hash, 'hex'))
}

const dummyPasswordRecord = {
  algorithm: 'pbkdf2-sha256',
  iterations: passwordIterations,
  salt: '00000000000000000000000000000000',
  hash: '0000000000000000000000000000000000000000000000000000000000000000',
}

function pruneRateLimitBuckets(buckets, now, force = false) {
  const nextSweepAt = rateLimitSweepTimes.get(buckets) || 0
  if (!force && now < nextSweepAt) return
  for (const [key, bucket] of buckets) {
    if (!(bucket.resetAt > now)) buckets.delete(key)
  }
  rateLimitSweepTimes.set(buckets, now + rateLimitSweepIntervalMs)
}

export function consumeRateLimit(
  buckets,
  key,
  maxAttempts,
  windowMs,
  now = Date.now(),
  bucketLimit = maxRateLimitBuckets,
) {
  pruneRateLimitBuckets(buckets, now)
  let current = buckets.get(key)
  if (current && !(current.resetAt > now)) {
    buckets.delete(key)
    current = null
  }
  if (!current && buckets.size >= bucketLimit) {
    pruneRateLimitBuckets(buckets, now, true)
    if (buckets.size >= bucketLimit) return false
  }
  if (current?.count >= maxAttempts) return false
  buckets.set(key, {
    count: current ? current.count + 1 : 1,
    resetAt: current ? current.resetAt : now + windowMs,
  })
  return true
}

function consumeLoginRateLimit(request) {
  return consumeRateLimit(
    loginAttemptsByIp,
    request.socket.remoteAddress || 'unknown',
    maxLoginAttemptsPerIp,
    loginRateWindowMs,
  )
}

function consumeRegistrationRateLimit(request) {
  return consumeRateLimit(
    registrationAttemptsByIp,
    request.socket.remoteAddress || 'unknown',
    maxRegistrationAttemptsPerIp,
    registrationRateWindowMs,
  )
}

function recordFailedLogin(accountId) {
  const now = Date.now()
  const current = failedLoginAttempts.get(accountId)
  const active = current && current.firstAttemptAt > now - failedLoginWindowMs
  const count = active ? current.count + 1 : 1
  failedLoginAttempts.set(accountId, {
    count,
    firstAttemptAt: active ? current.firstAttemptAt : now,
    blockedUntil: count >= maxFailedLoginAttempts ? now + loginLockMs : 0,
  })
}

function serializeLogin(email, operation) {
  const previous = loginQueues.get(email) || Promise.resolve()
  const current = previous.catch(() => undefined).then(operation)
  loginQueues.set(email, current)
  return current.finally(() => {
    if (loginQueues.get(email) === current) loginQueues.delete(email)
  })
}

function requestSessionToken(request) {
  const match = /^Bearer ([a-f0-9]{64})$/i.exec(cleanText(request.get('Authorization'), 80))
  return match?.[1].toLowerCase() || ''
}

function addSession(data, accountId) {
  const now = Date.now()
  data.sessions = data.sessions.filter(({ expiresAt }) => Date.parse(expiresAt) > now)
  const accountSessions = data.sessions
    .filter((session) => session.accountId === accountId)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
  const retainedSessions = new Set(accountSessions.slice(0, maxActiveSessions - 1))
  data.sessions = data.sessions.filter((session) => (
    session.accountId !== accountId || retainedSessions.has(session)
  ))
  const token = crypto.randomBytes(32).toString('hex')
  data.sessions.push({
    tokenHash: hashParticipantToken(token),
    accountId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + sessionLifetimeMs).toISOString(),
  })
  return token
}

async function authenticatedAccount(request) {
  if (instanceConfig.accounts.mode === 'disabled') return null
  const token = requestSessionToken(request)
  if (!token) return null
  const data = await readAuthData()
  const tokenHash = hashParticipantToken(token)
  const session = data.sessions.find((item) => item.tokenHash === tokenHash
    && Date.parse(item.expiresAt) > Date.now())
  return session ? data.accounts.find(({ id }) => id === session.accountId) || null : null
}

function serializePoll(poll, participantToken = '') {
  const tokenHash = participantToken ? hashParticipantToken(participantToken) : ''
  let viewerParticipantId
  const {
    managementTokenHash: _managementTokenHash,
    ownerId: _ownerId,
    participants: storedParticipants,
    ...details
  } = poll
  const participants = storedParticipants.map(({ editTokenHash, ...participant }) => {
    if (tokenHash && editTokenHash === tokenHash) viewerParticipantId = participant.id
    return participant
  })
  return {
    ...details,
    participants,
    ...(viewerParticipantId ? { viewerParticipantId } : {}),
  }
}

function hasManagementAccess(request, poll, account) {
  if (account && poll.ownerId === account.id) return true
  const token = cleanText(request.get('X-Rally-Management-Token'), 64)
  if (!/^[a-f0-9]{48}$/.test(token) || !/^[a-f0-9]{64}$/.test(poll.managementTokenHash || '')) {
    return false
  }
  return crypto.timingSafeEqual(
    Buffer.from(hashParticipantToken(token), 'hex'),
    Buffer.from(poll.managementTokenHash, 'hex'),
  )
}

function updatedOptions(options, currentPoll) {
  const existingIds = new Set(currentPoll.options.map(({ id }) => id))
  const usedIds = new Set()
  return options.map((option) => {
    const requestedId = cleanText(option?.id, 20)
    const id = existingIds.has(requestedId) && !usedIds.has(requestedId)
      ? requestedId
      : crypto.randomBytes(5).toString('hex')
    usedIds.add(id)
    return {
      id,
      date: cleanText(option.date, 10),
      time: cleanText(option.time, 5),
    }
  })
}

function normalizeParticipantVotes(participants, options) {
  for (const participant of participants) {
    participant.votes = Object.fromEntries(options.map(({ id }) => [
      id,
      ['yes', 'maybe', 'no'].includes(participant.votes[id]) ? participant.votes[id] : 'no',
    ]))
  }
}

function validateOptions(options) {
  if (!Array.isArray(options) || options.length === 0) {
    return 'Choose at least one date.'
  }

  if (maxPollDates !== null && options.length > maxPollDates) {
    return `Polls can include up to ${maxPollDates} dates.`
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

app.get('/api/health', (_request, response) => {
  response.json({ status: 'ok' })
})

app.get('/api/config', (_request, response) => {
  response.json({
    maxDates: instanceConfig.polls.maxDates,
    site: instanceConfig.site,
    accounts: instanceConfig.accounts,
    polls: instanceConfig.polls,
  })
})

app.post('/api/auth/register', async (request, response, next) => {
  try {
    if (instanceConfig.accounts.mode === 'disabled') {
      return response.status(403).json({ error: 'Accounts are disabled.' })
    }
    if (instanceConfig.accounts.registration === 'closed') {
      return response.status(403).json({ error: 'Registration is closed.' })
    }
    const email = normalizeEmail(request.body.email)
    const name = cleanText(request.body.name, 60)
    const password = typeof request.body.password === 'string' ? request.body.password : ''
    if (!validEmail(email) || !name || password.length < 10 || password.length > 128) {
      return response.status(400).json({
        error: 'Enter a name, a valid email, and a password of 10 to 128 characters.',
      })
    }
    if (!consumeRegistrationRateLimit(request)) {
      return response.status(429).json({
        error: 'Too many account registrations. Try again later.',
      })
    }

    const passwordHash = await passwordRecord(password)
    const result = await updateAuthData((data) => {
      if (data.accounts.some((account) => account.email === email)) {
        return { error: 'An account with that email already exists.' }
      }
      const account = {
        id: crypto.randomBytes(10).toString('hex'),
        email,
        name,
        passwordHash,
        createdAt: new Date().toISOString(),
      }
      data.accounts.push(account)
      return { user: publicAccount(account), token: addSession(data, account.id) }
    })

    if (result.error) return response.status(409).json({ error: result.error })
    return response.status(201).json(result)
  } catch (error) {
    return next(error)
  }
})

app.post('/api/auth/login', async (request, response, next) => {
  try {
    if (instanceConfig.accounts.mode === 'disabled') {
      return response.status(403).json({ error: 'Accounts are disabled.' })
    }
    const email = normalizeEmail(request.body.email)
    const password = typeof request.body.password === 'string' ? request.body.password : ''
    if (!consumeLoginRateLimit(request)) {
      return response.status(429).json({ error: 'Too many sign-in attempts. Try again later.' })
    }
    if (!validEmail(email) || !password || password.length > 128) {
      return response.status(401).json({ error: 'Email or password is incorrect.' })
    }
    const result = await serializeLogin(email, async () => {
      const data = await readAuthData()
      const account = data.accounts.find((item) => item.email === email)
      const currentFailure = account ? failedLoginAttempts.get(account.id) : null
      if (currentFailure?.blockedUntil > Date.now()) {
        return { status: 429, error: 'Too many sign-in attempts. Try again later.' }
      }
      const matches = account
        ? await passwordMatches(password, account.passwordHash)
        : await passwordMatches(password, dummyPasswordRecord)
      if (!account || !matches) {
        if (account) recordFailedLogin(account.id)
        return { status: 401, error: 'Email or password is incorrect.' }
      }
      failedLoginAttempts.delete(account.id)
      const token = await updateAuthData((currentData) => addSession(currentData, account.id))
      return { status: 200, user: publicAccount(account), token }
    })
    if (result.error) return response.status(result.status).json({ error: result.error })
    return response.json({ user: result.user, token: result.token })
  } catch (error) {
    return next(error)
  }
})

app.get('/api/auth/session', async (request, response, next) => {
  try {
    if (instanceConfig.accounts.mode === 'disabled') {
      return response.status(403).json({ error: 'Accounts are disabled.' })
    }
    const account = await authenticatedAccount(request)
    if (!account) return response.status(401).json({ error: 'Sign in required.' })
    return response.json({ user: publicAccount(account) })
  } catch (error) {
    return next(error)
  }
})

app.delete('/api/auth/session', async (request, response, next) => {
  try {
    if (instanceConfig.accounts.mode === 'disabled') {
      return response.status(403).json({ error: 'Accounts are disabled.' })
    }
    const token = requestSessionToken(request)
    if (token) {
      const tokenHash = hashParticipantToken(token)
      await updateAuthData((data) => {
        data.sessions = data.sessions.filter((session) => session.tokenHash !== tokenHash)
      })
    }
    return response.json({ signedOut: true })
  } catch (error) {
    return next(error)
  }
})

app.get('/api/account/polls', async (request, response, next) => {
  try {
    if (instanceConfig.accounts.mode === 'disabled') {
      return response.status(403).json({ error: 'Accounts are disabled.' })
    }
    const account = await authenticatedAccount(request)
    if (!account) return response.status(401).json({ error: 'Sign in required.' })
    const polls = await readPolls()
    return response.json({
      polls: polls.filter(({ ownerId }) => ownerId === account.id).map((poll) => serializePoll(poll)),
    })
  } catch (error) {
    return next(error)
  }
})

app.post('/api/account/polls/claim', async (request, response, next) => {
  try {
    if (instanceConfig.accounts.mode === 'disabled') {
      return response.status(403).json({ error: 'Accounts are disabled.' })
    }
    const account = await authenticatedAccount(request)
    if (!account) return response.status(401).json({ error: 'Sign in required.' })
    const pollId = cleanText(request.body.pollId, 20)
    const result = await updatePolls((polls) => {
      const poll = polls.find(({ id }) => id === pollId)
      if (!poll) return { status: 404, error: 'Poll not found.' }
      if (poll.ownerId && poll.ownerId !== account.id) {
        return { status: 409, error: 'This poll already belongs to another account.' }
      }
      if (!hasManagementAccess(request, poll, null)) {
        return { status: 403, error: 'Organizer access required.' }
      }
      poll.ownerId = account.id
      return { poll: serializePoll(poll) }
    })
    if (result.error) return response.status(result.status).json({ error: result.error })
    return response.json(result.poll)
  } catch (error) {
    return next(error)
  }
})

app.post('/api/polls', async (request, response, next) => {
  try {
    const title = cleanText(request.body.title, 100)
    const organizer = cleanText(request.body.organizer, 60)
    const optionsError = validateOptions(request.body.options)

    if (!title || !organizer || optionsError) {
      return response.status(400).json({
        error: optionsError || 'A title and organizer name are required.',
      })
    }

    const account = await authenticatedAccount(request)
    if (instanceConfig.accounts.mode !== 'disabled'
      && request.get('Authorization')
      && !account) {
      return response.status(401).json({ error: 'Sign in required.' })
    }
    if (instanceConfig.accounts.mode === 'required' && !account) {
      return response.status(401).json({ error: 'Sign in required.' })
    }
    const poll = {
      id: crypto.randomBytes(5).toString('hex'),
      title,
      organizer,
      description: cleanText(request.body.description, 500),
      location: cleanText(request.body.location, 120),
      createdAt: new Date().toISOString(),
      status: 'open',
      options: request.body.options.map((option) => ({
        id: crypto.randomBytes(5).toString('hex'),
        date: cleanText(option.date, 10),
        time: cleanText(option.time, 5),
      })),
      participants: [],
      ...(account ? { ownerId: account.id } : {}),
    }

    const managementToken = crypto.randomBytes(24).toString('hex')
    poll.managementTokenHash = hashParticipantToken(managementToken)

    await updatePolls((polls) => polls.push(poll))
    return response.status(201).json({ ...serializePoll(poll), managementToken })
  } catch (error) {
    return next(error)
  }
})

app.get('/api/polls/:pollId', async (request, response, next) => {
  try {
    const polls = await readPolls()
    const poll = polls.find((item) => item.id === request.params.pollId)
    if (!poll) return response.status(404).json({ error: 'Poll not found.' })
    const participantToken = cleanText(request.get('X-Rally-Participant-Token'), 64)
    return response.json(serializePoll(poll, participantToken))
  } catch (error) {
    return next(error)
  }
})

app.get('/api/polls/:pollId/manage', async (request, response, next) => {
  try {
    const polls = await readPolls()
    const poll = polls.find((item) => item.id === request.params.pollId)
    if (!poll) return response.status(404).json({ error: 'Poll not found.' })
    const account = hasManagementAccess(request, poll, null)
      ? null
      : await authenticatedAccount(request)
    if (!hasManagementAccess(request, poll, account)) {
      return response.status(403).json({ error: 'Organizer access required.' })
    }
    return response.json(serializePoll(poll))
  } catch (error) {
    return next(error)
  }
})

app.patch('/api/polls/:pollId', async (request, response, next) => {
  try {
    const optionsError = request.body.options === undefined
      ? null
      : validateOptions(request.body.options)
    if (optionsError) return response.status(400).json({ error: optionsError })
    if (request.body.status !== undefined && !['open', 'closed'].includes(request.body.status)) {
      return response.status(400).json({ error: 'Poll status must be open or closed.' })
    }

    const existingPoll = (await readPolls()).find((item) => item.id === request.params.pollId)
    const account = existingPoll && !hasManagementAccess(request, existingPoll, null)
      ? await authenticatedAccount(request)
      : null
    const result = await updatePolls((polls) => {
      const poll = polls.find((item) => item.id === request.params.pollId)
      if (!poll) return { status: 404, error: 'Poll not found.' }
      if (!hasManagementAccess(request, poll, account)) {
        return { status: 403, error: 'Organizer access required.' }
      }

      const title = request.body.title === undefined
        ? poll.title
        : cleanText(request.body.title, 100)
      const organizer = request.body.organizer === undefined
        ? poll.organizer
        : cleanText(request.body.organizer, 60)
      if (!title || !organizer) {
        return { status: 400, error: 'A title and organizer name are required.' }
      }

      poll.title = title
      poll.organizer = organizer
      poll.description = request.body.description === undefined
        ? poll.description
        : cleanText(request.body.description, 500)
      poll.location = request.body.location === undefined
        ? poll.location
        : cleanText(request.body.location, 120)
      poll.status = request.body.status ?? poll.status
      if (request.body.options !== undefined) {
        poll.options = updatedOptions(request.body.options, poll)
        normalizeParticipantVotes(poll.participants, poll.options)
      }
      return { poll: serializePoll(poll) }
    })

    if (result.error) return response.status(result.status).json({ error: result.error })
    return response.json(result.poll)
  } catch (error) {
    return next(error)
  }
})

app.delete('/api/polls/:pollId', async (request, response, next) => {
  try {
    const existingPoll = (await readPolls()).find((item) => item.id === request.params.pollId)
    const account = existingPoll && !hasManagementAccess(request, existingPoll, null)
      ? await authenticatedAccount(request)
      : null
    const result = await updatePolls((polls) => {
      const pollIndex = polls.findIndex((item) => item.id === request.params.pollId)
      if (pollIndex < 0) return { status: 404, error: 'Poll not found.' }
      if (!hasManagementAccess(request, polls[pollIndex], account)) {
        return { status: 403, error: 'Organizer access required.' }
      }
      polls.splice(pollIndex, 1)
      return { deleted: true }
    })

    if (result.error) return response.status(result.status).json({ error: result.error })
    return response.json(result)
  } catch (error) {
    return next(error)
  }
})

app.put('/api/polls/:pollId/responses', async (request, response, next) => {
  try {
    const name = cleanText(request.body.name, 60)
    const requestedToken = cleanText(request.body.participantId, 64)
    if (!name) return response.status(400).json({ error: 'Enter your name.' })

    const result = await updatePolls((polls) => {
      const currentPoll = polls.find((item) => item.id === request.params.pollId)
      if (!currentPoll) return null
      if (currentPoll.status === 'closed') return { pollClosed: true }

      const votes = Object.fromEntries(
        currentPoll.options.map((option) => {
          const vote = request.body.votes?.[option.id]
          return [option.id, ['yes', 'maybe', 'no'].includes(vote) ? vote : 'no']
        }),
      )
      const requestedTokenHash = /^[a-f0-9]{48}$/.test(requestedToken)
        ? hashParticipantToken(requestedToken)
        : ''
      const existingParticipant = currentPoll.participants.find(
        (participant) => participant.editTokenHash === requestedTokenHash,
      )
      if (!existingParticipant && currentPoll.participants.length >= maxPollResponses) {
        return { responseLimitReached: true }
      }
      let participantToken = requestedToken

      if (existingParticipant) {
        existingParticipant.name = name
        existingParticipant.votes = votes
        existingParticipant.updatedAt = new Date().toISOString()
      } else {
        participantToken = crypto.randomBytes(24).toString('hex')
        currentPoll.participants.push({
          id: crypto.randomBytes(5).toString('hex'),
          editTokenHash: hashParticipantToken(participantToken),
          name,
          votes,
          updatedAt: new Date().toISOString(),
        })
      }

      return { poll: serializePoll(currentPoll, participantToken), participantId: participantToken }
    })

    if (!result) return response.status(404).json({ error: 'Poll not found.' })
    if (result.pollClosed) return response.status(409).json({ error: 'This poll is closed.' })
    if (result.responseLimitReached) {
      return response.status(409).json({ error: 'This poll has reached its response limit.' })
    }
    return response.json(result)
  } catch (error) {
    return next(error)
  }
})

app.use(express.static(distDirectory))
app.use(async (request, response, next) => {
  if (request.path.startsWith('/api/')) return next()

  try {
    await fs.access(path.join(distDirectory, 'index.html'))
    return response.sendFile(path.join(distDirectory, 'index.html'))
  } catch {
    return response.status(404).send('Build the client with npm run build first.')
  }
})

app.use((error, _request, response, _next) => {
  if (error?.type === 'entity.too.large') {
    return response.status(413).json({ error: 'Request body is too large.' })
  }
  if (error?.type === 'entity.parse.failed') {
    return response.status(400).json({ error: 'Request body must be valid JSON.' })
  }
  console.error(error)
  return response.status(500).json({ error: 'Something went wrong.' })
})

export { app }

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  app.listen(port, () => {
    console.log(`Rally API listening on http://localhost:${port}`)
  })
}