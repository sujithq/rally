import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'

const modulePath = fileURLToPath(import.meta.url)
const __dirname = path.dirname(modulePath)
const rootDirectory = path.resolve(__dirname, '..')
const dataDirectory = path.join(rootDirectory, 'data')
const dataFile = process.env.RALLY_DATA_FILE
  ? path.resolve(process.env.RALLY_DATA_FILE)
  : path.join(dataDirectory, 'polls.json')
const distDirectory = path.join(rootDirectory, 'dist')
const port = Number(process.env.PORT) || 4174
const defaultMaxPollResponses = 100

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

const maxPollDates = parseMaxDates(process.env.MAX_POLL_DATES)
const maxPollResponses = parseMaxResponses(process.env.MAX_POLL_RESPONSES)
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

function serializePoll(poll, participantToken = '') {
  const tokenHash = participantToken ? hashParticipantToken(participantToken) : ''
  let viewerParticipantId
  const { managementTokenHash: _managementTokenHash, participants: storedParticipants, ...details } = poll
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

function hasManagementAccess(request, poll) {
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
  response.json({ maxDates: maxPollDates })
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
    if (!hasManagementAccess(request, poll)) {
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

    const result = await updatePolls((polls) => {
      const poll = polls.find((item) => item.id === request.params.pollId)
      if (!poll) return { status: 404, error: 'Poll not found.' }
      if (!hasManagementAccess(request, poll)) {
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
    const result = await updatePolls((polls) => {
      const pollIndex = polls.findIndex((item) => item.id === request.params.pollId)
      if (pollIndex < 0) return { status: 404, error: 'Poll not found.' }
      if (!hasManagementAccess(request, polls[pollIndex])) {
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