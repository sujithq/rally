import { type FormEvent, useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  CalendarDays,
  Check,
  CheckCircle2,
  Clock3,
  Copy,
  HelpCircle,
  LoaderCircle,
  Lock,
  MapPin,
  RefreshCw,
  Trophy,
  UserRound,
  X,
} from 'lucide-react'
import { getPoll, saveResponse } from './api'
import { formatDate, formatTime } from './date'
import type { Poll, PollOption, Vote } from './types'

const voteChoices: { value: Vote; label: string; icon: typeof Check }[] = [
  { value: 'yes', label: 'Yes', icon: Check },
  { value: 'maybe', label: 'Maybe', icon: HelpCircle },
  { value: 'no', label: 'No', icon: X },
]

interface PollPageProps {
  pollId: string
  onCreateNew: () => void
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase()
}

function optionTallies(poll: Poll, option: PollOption) {
  return poll.participants.reduce(
    (totals, participant) => {
      totals[participant.votes[option.id] || 'no'] += 1
      return totals
    },
    { yes: 0, maybe: 0, no: 0 },
  )
}

function VoteIcon({ vote }: { vote: Vote }) {
  if (vote === 'yes') return <Check size={17} aria-label="Yes" />
  if (vote === 'maybe') return <HelpCircle size={17} aria-label="Maybe" />
  return <X size={17} aria-label="No" />
}

export default function PollPage({ pollId, onCreateNew }: PollPageProps) {
  const storageKey = `rally-participant-${pollId}`
  const [poll, setPoll] = useState<Poll | null>(null)
  const [participantToken, setParticipantToken] = useState(() => localStorage.getItem(storageKey) || '')
  const [name, setName] = useState('')
  const [votes, setVotes] = useState<Record<string, Vote>>({})
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState(false)
  const requestVersion = useRef(0)
  const refreshInFlight = useRef(false)
  const savingInFlight = useRef(false)

  const refreshPoll = async (manual = false) => {
    if (refreshInFlight.current || savingInFlight.current) return
    refreshInFlight.current = true
    const currentRequest = ++requestVersion.current
    if (manual) {
      setRefreshing(true)
      setError('')
    }
    try {
      const storedToken = localStorage.getItem(storageKey) || ''
      const nextPoll = await getPoll(pollId, storedToken)
      if (currentRequest === requestVersion.current) setPoll(nextPoll)
    } catch (requestError) {
      if (manual && currentRequest === requestVersion.current) {
        setError(requestError instanceof Error ? requestError.message : 'Could not refresh this poll.')
      }
    } finally {
      refreshInFlight.current = false
      if (manual) setRefreshing(false)
    }
  }

  useEffect(() => {
    let active = true
    const currentRequest = ++requestVersion.current
    setLoading(true)
    setPoll(null)
    setParticipantToken('')
    setName('')
    setVotes({})
    setError('')

    const loadPoll = async () => {
      try {
        const storedToken = localStorage.getItem(storageKey) || ''
        const nextPoll = await getPoll(pollId, storedToken)
        if (!active || currentRequest !== requestVersion.current) return
        setPoll(nextPoll)
        const existingResponse = nextPoll.participants.find(
          (participant) => participant.id === nextPoll.viewerParticipantId,
        )
        if (existingResponse) {
          setParticipantToken(storedToken)
          setName(existingResponse.name)
          setVotes(existingResponse.votes)
        }
      } catch (requestError) {
        if (active && currentRequest === requestVersion.current) {
          setError(requestError instanceof Error ? requestError.message : 'Could not load this poll.')
        }
      } finally {
        if (active && currentRequest === requestVersion.current) setLoading(false)
      }
    }

    void loadPoll()
    return () => {
      active = false
      requestVersion.current += 1
    }
  }, [pollId])

  useEffect(() => {
    if (loading || !poll) return

    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void refreshPoll()
    }
    const interval = window.setInterval(refreshWhenVisible, 5000)
    window.addEventListener('focus', refreshWhenVisible)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', refreshWhenVisible)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [loading, pollId])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (poll?.status === 'closed') {
      setError('This poll is closed.')
      return
    }
    if (!poll || !name.trim()) {
      setError('Enter your name before saving.')
      return
    }
    if (poll.options.some((option) => !votes[option.id])) {
      setError('Choose Yes, Maybe, or No for every date.')
      return
    }

    savingInFlight.current = true
    const currentRequest = ++requestVersion.current
    setSaving(true)
    setSaved(false)
    setError('')
    try {
      const result = await saveResponse(pollId, { participantId: participantToken, name, votes })
      if (currentRequest !== requestVersion.current) return
      setPoll(result.poll)
      setParticipantToken(result.participantId)
      localStorage.setItem(storageKey, result.participantId)
      setSaved(true)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not save your response.')
    } finally {
      savingInFlight.current = false
      setSaving(false)
    }
  }

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2200)
    } catch {
      setError('Copy the poll link from your browser address bar.')
    }
  }

  if (loading) {
    return (
      <main className="status-page">
        <LoaderCircle className="spin" size={30} />
        <p>Loading poll...</p>
      </main>
    )
  }

  if (!poll) {
    return (
      <main className="status-page">
        <span className="status-icon error"><AlertCircle size={28} /></span>
        <h1>Poll not found</h1>
        <p>{error || 'This link may be incomplete or the poll is no longer available.'}</p>
        <button className="button button-dark" type="button" onClick={onCreateNew}>Create a new poll</button>
      </main>
    )
  }

  const rankedOptions = poll.options
    .map((option) => ({ option, ...optionTallies(poll, option) }))
    .sort((left, right) => (right.yes * 2 + right.maybe) - (left.yes * 2 + left.maybe))
  const bestOptionId = poll.participants.length ? rankedOptions[0]?.option.id : null
  const answeredCount = poll.options.filter((option) => votes[option.id]).length

  return (
    <main className="poll-page">
      <section className="poll-hero">
        <div className="poll-hero-main">
          <span className="eyebrow">Group poll - {poll.status}</span>
          <h1>{poll.title}</h1>
          <div className="poll-meta">
            <span><UserRound size={16} /> Hosted by {poll.organizer}</span>
            {poll.location && <span><MapPin size={16} /> {poll.location}</span>}
          </div>
          {poll.description && <p className="poll-description">{poll.description}</p>}
        </div>
        <button className="button button-outline share-button" type="button" onClick={copyLink}>
          {copied ? <CheckCircle2 size={18} /> : <Copy size={18} />}
          {copied ? 'Link copied' : 'Copy invite link'}
        </button>
      </section>

      <div className="poll-layout">
        <section className="availability-panel" aria-labelledby="availability-heading">
          <div className="poll-section-heading">
            <div>
              <span className="step-number">01</span>
              <h2 id="availability-heading">Your availability</h2>
              <p>Respond to each option, then save your picks.</p>
            </div>
            <span className="answer-count">{answeredCount}/{poll.options.length} answered</span>
          </div>

          <form onSubmit={submit}>
            {poll.status === 'closed' && (
              <div className="closed-poll-notice" role="status">
                <Lock size={18} />
                <span>This poll is closed. Existing responses remain visible.</span>
              </div>
            )}
            <div className="response-name field-group">
              <label htmlFor="participant-name">Your name</label>
              <input
                id="participant-name"
                value={name}
                onChange={(event) => {
                  setName(event.target.value)
                  setSaved(false)
                }}
                placeholder="Enter your name"
                maxLength={60}
                required
                disabled={poll.status === 'closed'}
              />
            </div>

            <div className="option-list">
              {poll.options.map((option) => {
                const tallies = optionTallies(poll, option)
                const formattedDate = formatDate(option.date)
                const dateParts = formattedDate.split(' ')
                return (
                  <div className="vote-option" key={option.id}>
                    <div className="option-date-block">
                      <span className="option-month">{dateParts[1]}</span>
                      <strong>{dateParts[2]}</strong>
                    </div>
                    <div className="option-copy">
                      <strong>{formattedDate}</strong>
                      <span><Clock3 size={15} /> {formatTime(option.time)}</span>
                    </div>
                    <div className="vote-segments" role="group" aria-label={`Availability for ${formattedDate}`}>
                      {voteChoices.map((choice) => {
                        const Icon = choice.icon
                        return (
                          <button
                            className={`vote-choice ${choice.value}${votes[option.id] === choice.value ? ' active' : ''}`}
                            type="button"
                            key={choice.value}
                            onClick={() => {
                              setVotes((current) => ({ ...current, [option.id]: choice.value }))
                              setSaved(false)
                              setError('')
                            }}
                            aria-pressed={votes[option.id] === choice.value}
                            disabled={poll.status === 'closed'}
                          >
                            <Icon size={17} />
                            <span>{choice.label}</span>
                          </button>
                        )
                      })}
                    </div>
                    <div className="mini-tally" title={`${tallies.yes} yes, ${tallies.maybe} maybe`}>
                      <span>{tallies.yes} yes</span>
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="save-row">
              <div className={`save-feedback${saved ? ' success' : ''}`} role="status">
                {saved ? <><CheckCircle2 size={17} /> Availability saved</> : error}
              </div>
              <button className="button button-primary button-large" type="submit" disabled={saving || poll.status === 'closed'}>
                {poll.status === 'closed' ? 'Poll closed' : saving ? 'Saving...' : participantToken ? 'Update availability' : 'Save availability'}
              </button>
            </div>
          </form>
        </section>

        <aside className="results-panel" aria-labelledby="results-heading">
          <div className="results-header">
            <div>
              <span className="step-number">02</span>
              <h2 id="results-heading">Current results</h2>
            </div>
            <button
              className="icon-button"
              type="button"
              onClick={() => void refreshPoll(true)}
              disabled={refreshing}
              aria-label="Refresh results"
              title="Refresh results"
            >
              <RefreshCw className={refreshing ? 'spin' : ''} size={17} />
            </button>
          </div>

          <div className="participant-summary">
            <div className="avatar-stack" aria-hidden="true">
              {poll.participants.slice(0, 4).map((participant) => (
                <span className="avatar" key={participant.id}>{initials(participant.name)}</span>
              ))}
            </div>
            <span>{poll.participants.length} {poll.participants.length === 1 ? 'response' : 'responses'}</span>
          </div>

          {poll.participants.length === 0 ? (
            <div className="results-empty">
              <CalendarDays size={24} />
              <strong>No responses yet</strong>
              <span>Share the invite link to get started.</span>
            </div>
          ) : (
            <div className="ranked-results">
              {rankedOptions.map((result, index) => {
                const positive = result.yes + result.maybe
                const width = poll.participants.length ? (positive / poll.participants.length) * 100 : 0
                return (
                  <div className={`ranked-option${result.option.id === bestOptionId ? ' best' : ''}`} key={result.option.id}>
                    <div className="ranked-topline">
                      <div>
                        {result.option.id === bestOptionId && <Trophy size={15} />}
                        <strong>{formatDate(result.option.date)}</strong>
                      </div>
                      <span>{result.yes} yes / {result.maybe} maybe</span>
                    </div>
                    <div className="result-bar"><span style={{ width: `${width}%` }} /></div>
                    {index === 0 && result.option.id === bestOptionId && <span className="best-label">Best match</span>}
                  </div>
                )
              })}
            </div>
          )}
        </aside>
      </div>

      {poll.participants.length > 0 && (
        <section className="response-grid-section" aria-labelledby="responses-heading">
          <div className="table-heading">
            <div>
              <span className="eyebrow">All responses</span>
              <h2 id="responses-heading">Availability at a glance</h2>
            </div>
            <div className="table-legend">
              <span className="yes"><Check size={14} /> Yes</span>
              <span className="maybe"><HelpCircle size={14} /> Maybe</span>
              <span className="no"><X size={14} /> No</span>
            </div>
          </div>
          <div className="response-table-wrap">
            <table className="response-table">
              <thead>
                <tr>
                  <th>Participant</th>
                  {poll.options.map((option) => (
                    <th key={option.id}>
                      <strong>{formatDate(option.date)}</strong>
                      <span>{formatTime(option.time)}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {poll.participants.map((participant) => (
                  <tr className={participant.id === poll.viewerParticipantId ? 'current-user' : ''} key={participant.id}>
                    <th><span className="avatar">{initials(participant.name)}</span>{participant.name}</th>
                    {poll.options.map((option) => {
                      const vote = participant.votes[option.id] || 'no'
                      return <td className={vote} key={option.id}><VoteIcon vote={vote} /></td>
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  )
}