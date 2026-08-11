import { type FormEvent, useEffect, useState } from 'react'
import {
  AlertCircle,
  ArrowLeft,
  CalendarDays,
  CheckCircle2,
  Clock3,
  Copy,
  ExternalLink,
  Link2,
  LoaderCircle,
  Lock,
  MapPin,
  Plus,
  Save,
  Trash2,
  Unlock,
  Users,
} from 'lucide-react'
import { deletePoll, getManagedPoll, updatePoll } from './api'
import {
  forgetManagedPoll,
  inviteUrl,
  managementUrl,
  rememberManagedPoll,
} from './managedPolls'
import type { Poll, PollOptionInput } from './types'

interface EditableOption extends PollOptionInput {
  id?: string
  clientId: string
}

interface ManagePollProps {
  pollId: string
  managementToken: string
  maxDates: number | null
  onNavigate: (path: string) => void
}

function editableOptions(poll: Poll): EditableOption[] {
  return poll.options.map((option) => ({ ...option, clientId: option.id }))
}

export default function ManagePoll({
  pollId,
  managementToken,
  maxDates,
  onNavigate,
}: ManagePollProps) {
  const reference = { id: pollId, managementToken }
  const [poll, setPoll] = useState<Poll | null>(null)
  const [title, setTitle] = useState('')
  const [organizer, setOrganizer] = useState('')
  const [location, setLocation] = useState('')
  const [description, setDescription] = useState('')
  const [options, setOptions] = useState<EditableOption[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [changingStatus, setChangingStatus] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState<'invite' | 'management' | ''>('')

  const applyPoll = (nextPoll: Poll) => {
    setPoll(nextPoll)
    setTitle(nextPoll.title)
    setOrganizer(nextPoll.organizer)
    setLocation(nextPoll.location)
    setDescription(nextPoll.description)
    setOptions(editableOptions(nextPoll))
  }

  useEffect(() => {
    let active = true
    setLoading(true)
    getManagedPoll(pollId, managementToken)
      .then((nextPoll) => {
        if (!active) return
        applyPoll(nextPoll)
        rememberManagedPoll(reference)
      })
      .catch((requestError) => {
        if (active) {
          setError(requestError instanceof Error ? requestError.message : 'Could not open this poll.')
        }
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [pollId, managementToken])

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!title.trim() || !organizer.trim() || options.length === 0) {
      setError('Add a title, organizer, and at least one date option.')
      return
    }
    if (options.some(({ date }) => !date)) {
      setError('Every option needs a date.')
      return
    }

    setSaving(true)
    setSaved(false)
    setError('')
    try {
      const nextPoll = await updatePoll(pollId, managementToken, {
        title,
        organizer,
        location,
        description,
        options: options.map(({ id, date, time }) => ({ id, date, time })),
      })
      applyPoll(nextPoll)
      setSaved(true)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not save this poll.')
    } finally {
      setSaving(false)
    }
  }

  const toggleStatus = async () => {
    if (!poll) return
    setChangingStatus(true)
    setError('')
    try {
      const nextPoll = await updatePoll(pollId, managementToken, {
        status: poll.status === 'open' ? 'closed' : 'open',
      })
      setPoll(nextPoll)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not update poll status.')
    } finally {
      setChangingStatus(false)
    }
  }

  const copyLink = async (kind: 'invite' | 'management') => {
    try {
      await navigator.clipboard.writeText(
        kind === 'invite' ? inviteUrl(pollId) : managementUrl(reference),
      )
      setCopied(kind)
      window.setTimeout(() => setCopied(''), 1800)
    } catch {
      setError('Could not copy the link.')
    }
  }

  const removePoll = async () => {
    if (!poll || !window.confirm(`Delete "${poll.title}" and all responses?`)) return
    setDeleting(true)
    setError('')
    try {
      await deletePoll(pollId, managementToken)
      forgetManagedPoll(pollId)
      onNavigate('/manage')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not delete this poll.')
      setDeleting(false)
    }
  }

  const updateOption = (clientId: string, update: Partial<EditableOption>) => {
    setOptions((current) => current.map((option) => (
      option.clientId === clientId ? { ...option, ...update } : option
    )))
    setSaved(false)
  }

  if (loading) {
    return <main className="status-page"><LoaderCircle className="spin" size={30} /><p>Opening poll...</p></main>
  }

  if (!poll) {
    return (
      <main className="status-page">
        <span className="status-icon error"><AlertCircle size={28} /></span>
        <h1>Organizer link unavailable</h1>
        <p>{error}</p>
        <button className="button button-dark" type="button" onClick={() => onNavigate('/manage')}>
          Back to My polls
        </button>
      </main>
    )
  }

  const atLimit = maxDates !== null && options.length >= maxDates

  return (
    <main className="manage-poll-page">
      <button className="manage-back" type="button" onClick={() => onNavigate('/manage')}>
        <ArrowLeft size={16} /> My polls
      </button>

      <section className="manage-hero">
        <div>
          <div className="manage-heading-meta">
            <span className={`poll-status ${poll.status}`}>{poll.status}</span>
            <span><Users size={15} /> {poll.participants.length} responses</span>
          </div>
          <h1>{poll.title}</h1>
        </div>
        <div className="manage-hero-actions">
          <button className="button button-outline" type="button" onClick={() => onNavigate(`/p/${pollId}`)}>
            <ExternalLink size={17} /> Open poll
          </button>
          <button className="icon-button" type="button" onClick={() => void copyLink('invite')} title="Copy invite" aria-label="Copy invite">
            {copied === 'invite' ? <CheckCircle2 size={17} /> : <Copy size={17} />}
          </button>
          <button className="icon-button" type="button" onClick={() => void copyLink('management')} title="Copy management link" aria-label="Copy management link">
            {copied === 'management' ? <CheckCircle2 size={17} /> : <Link2 size={17} />}
          </button>
        </div>
      </section>

      <div className="manage-status-strip">
        <div>
          {poll.status === 'open' ? <Unlock size={18} /> : <Lock size={18} />}
          <span>{poll.status === 'open' ? 'Accepting responses' : 'Responses paused'}</span>
        </div>
        <button
          className="button button-small button-dark"
          type="button"
          onClick={() => void toggleStatus()}
          disabled={changingStatus}
        >
          {poll.status === 'open' ? <Lock size={16} /> : <Unlock size={16} />}
          {changingStatus ? 'Updating...' : poll.status === 'open' ? 'Close poll' : 'Reopen poll'}
        </button>
      </div>

      <form className="manage-editor" onSubmit={save}>
        <section className="manage-details" aria-labelledby="manage-details-heading">
          <div className="section-heading">
            <span className="step-number">01</span>
            <div><h2 id="manage-details-heading">Poll details</h2></div>
          </div>
          <div className="field-group">
            <label htmlFor="manage-title">Title</label>
            <input id="manage-title" value={title} onChange={(event) => { setTitle(event.target.value); setSaved(false) }} maxLength={100} required />
          </div>
          <div className="field-group">
            <label htmlFor="manage-organizer">Organizer</label>
            <input id="manage-organizer" value={organizer} onChange={(event) => { setOrganizer(event.target.value); setSaved(false) }} maxLength={60} required />
          </div>
          <div className="field-group">
            <label htmlFor="manage-location">Location <span>optional</span></label>
            <div className="input-with-icon">
              <MapPin size={18} />
              <input id="manage-location" value={location} onChange={(event) => { setLocation(event.target.value); setSaved(false) }} maxLength={120} />
            </div>
          </div>
          <div className="field-group">
            <label htmlFor="manage-description">Note <span>optional</span></label>
            <textarea id="manage-description" value={description} onChange={(event) => { setDescription(event.target.value); setSaved(false) }} maxLength={500} rows={4} />
          </div>
        </section>

        <section className="manage-options" aria-labelledby="manage-options-heading">
          <div className="section-heading section-heading-row">
            <div className="heading-copy">
              <span className="step-number">02</span>
              <div><h2 id="manage-options-heading">Date options</h2></div>
            </div>
            <span className="date-count">{options.length}{maxDates === null ? ' options' : ` / ${maxDates}`}</span>
          </div>

          <div className="manage-option-list">
            {options.map((option, index) => (
              <div className="manage-option-row" key={option.clientId}>
                <span className="manage-option-number">{String(index + 1).padStart(2, '0')}</span>
                <label>
                  <CalendarDays size={17} />
                  <input type="date" value={option.date} onChange={(event) => updateOption(option.clientId, { date: event.target.value })} aria-label={`Date option ${index + 1}`} required />
                </label>
                <label>
                  <Clock3 size={16} />
                  <input type="time" value={option.time} onChange={(event) => updateOption(option.clientId, { time: event.target.value })} aria-label={`Time for option ${index + 1}`} />
                </label>
                <button
                  className="icon-button icon-button-danger"
                  type="button"
                  onClick={() => {
                    setOptions((current) => current.filter(({ clientId }) => clientId !== option.clientId))
                    setSaved(false)
                  }}
                  aria-label={`Remove option ${index + 1}`}
                  title="Remove option"
                  disabled={options.length === 1}
                >
                  <Trash2 size={17} />
                </button>
              </div>
            ))}
          </div>

          <button
            className="button button-outline"
            type="button"
            onClick={() => {
              setOptions((current) => [...current, {
                clientId: crypto.randomUUID(),
                date: '',
                time: '',
              }])
              setSaved(false)
            }}
            disabled={atLimit}
          >
            <Plus size={17} /> Add option
          </button>
        </section>

        <div className="manage-savebar">
          <div className={`save-feedback${saved ? ' success' : ''}`} role="status">
            {saved ? <><CheckCircle2 size={17} /> Poll updated</> : error}
          </div>
          <button className="button button-primary button-large" type="submit" disabled={saving}>
            <Save size={18} /> {saving ? 'Saving...' : 'Save changes'}
          </button>
        </div>
      </form>

      <section className="manage-danger" aria-labelledby="delete-heading">
        <div>
          <h2 id="delete-heading">Delete poll</h2>
          <p>{poll.participants.length} responses will be permanently removed.</p>
        </div>
        <button className="button button-danger" type="button" onClick={() => void removePoll()} disabled={deleting}>
          <Trash2 size={17} /> {deleting ? 'Deleting...' : 'Delete poll'}
        </button>
      </section>
    </main>
  )
}