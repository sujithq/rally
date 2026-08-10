import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDirectory = path.resolve(__dirname, '..')
const dataDirectory = path.join(rootDirectory, 'data')
const dataFile = path.join(dataDirectory, 'polls.json')
const distDirectory = path.join(rootDirectory, 'dist')
const port = Number(process.env.PORT) || 4174

function parseMaxDates(value) {
  const normalizedValue = value?.trim().toLowerCase()
  if (!normalizedValue || ['0', 'none', 'unlimited'].includes(normalizedValue)) return null
  if (!/^\d+$/.test(normalizedValue) || Number(normalizedValue) < 1) {
    throw new Error('MAX_POLL_DATES must be a positive integer, 0, none, or unlimited.')
  }
  return Number(normalizedValue)
}

const maxPollDates = parseMaxDates(process.env.MAX_POLL_DATES)
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
    await fs.mkdir(dataDirectory, { recursive: true })
    await fs.writeFile(dataFile, JSON.stringify(polls, null, 2))
    return result
  })

  writeQueue = update.catch(() => undefined)
  return update
}

function cleanText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
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
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return 'Every option needs a valid date.'
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

    await updatePolls((polls) => polls.push(poll))
    return response.status(201).json(poll)
  } catch (error) {
    return next(error)
  }
})

app.get('/api/polls/:pollId', async (request, response, next) => {
  try {
    const polls = await readPolls()
    const poll = polls.find((item) => item.id === request.params.pollId)
    if (!poll) return response.status(404).json({ error: 'Poll not found.' })
    return response.json(poll)
  } catch (error) {
    return next(error)
  }
})

app.put('/api/polls/:pollId/responses', async (request, response, next) => {
  try {
    const name = cleanText(request.body.name, 60)
    const participantId = cleanText(request.body.participantId, 20)
    if (!name) return response.status(400).json({ error: 'Enter your name.' })

    const result = await updatePolls((polls) => {
      const currentPoll = polls.find((item) => item.id === request.params.pollId)
      if (!currentPoll) return null

      const votes = Object.fromEntries(
        currentPoll.options.map((option) => {
          const vote = request.body.votes?.[option.id]
          return [option.id, ['yes', 'maybe', 'no'].includes(vote) ? vote : 'no']
        }),
      )
      const existingParticipant = currentPoll.participants.find(
        (participant) => participant.id === participantId,
      )

      if (existingParticipant) {
        existingParticipant.name = name
        existingParticipant.votes = votes
        existingParticipant.updatedAt = new Date().toISOString()
      } else {
        currentPoll.participants.push({
          id: crypto.randomBytes(5).toString('hex'),
          name,
          votes,
          updatedAt: new Date().toISOString(),
        })
      }

      const savedParticipant = existingParticipant || currentPoll.participants.at(-1)
      return { poll: currentPoll, participantId: savedParticipant.id }
    })

    if (!result) return response.status(404).json({ error: 'Poll not found.' })
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
  console.error(error)
  response.status(500).json({ error: 'Something went wrong.' })
})

app.listen(port, () => {
  console.log(`Rally API listening on http://localhost:${port}`)
})