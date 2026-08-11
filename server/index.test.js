import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'

let baseUrl
let server
let temporaryDirectory

before(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'rally-api-'))
  process.env.RALLY_DATA_FILE = path.join(temporaryDirectory, 'polls.json')
  process.env.MAX_POLL_DATES = 'unlimited'
  process.env.MAX_POLL_RESPONSES = '2'

  const { app } = await import('./index.js')
  server = app.listen(0, '127.0.0.1')
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