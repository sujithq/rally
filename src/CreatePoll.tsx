import { type FormEvent, useState } from 'react'
import { ArrowRight, CalendarDays, Clock3, MapPin, Trash2 } from 'lucide-react'
import { createPoll } from './api'
import CalendarPicker from './CalendarPicker'
import { formatDate } from './date'
import type { CreatedPoll } from './types'

interface CreatePollProps {
  maxDates: number | null
  onCreated: (poll: CreatedPoll) => void
}

export default function CreatePoll({ maxDates, onCreated }: CreatePollProps) {
  const [title, setTitle] = useState('')
  const [organizer, setOrganizer] = useState(() => localStorage.getItem('rally-organizer') || '')
  const [description, setDescription] = useState('')
  const [location, setLocation] = useState('')
  const [selectedDates, setSelectedDates] = useState<string[]>([])
  const [times, setTimes] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const atLimit = maxDates !== null && selectedDates.length >= maxDates

  const toggleDate = (date: string) => {
    setError('')
    setSelectedDates((current) => {
      if (current.includes(date)) return current.filter((item) => item !== date)
      if (maxDates !== null && current.length >= maxDates) return current
      return [...current, date].sort()
    })
  }

  const removeDate = (date: string) => {
    setSelectedDates((current) => current.filter((item) => item !== date))
    setTimes((current) => {
      const next = { ...current }
      delete next[date]
      return next
    })
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!title.trim() || !organizer.trim() || selectedDates.length === 0) {
      setError('Add a title, your name, and at least one date.')
      return
    }

    setSubmitting(true)
    setError('')
    try {
      const poll = await createPoll({
        title,
        organizer,
        description,
        location,
        options: selectedDates.map((date) => ({ date, time: times[date] || '' })),
      })
      try {
        localStorage.setItem('rally-organizer', organizer.trim())
      } catch {}
      onCreated(poll)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not create the poll.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="create-page">
      <div className="page-intro">
        <span className="eyebrow">New group poll</span>
        <h1>Find the date that fits.</h1>
        <p>Collect everyone&apos;s availability in one place.</p>
      </div>

      <form className="creator" onSubmit={submit}>
        <section className="details-panel" aria-labelledby="details-heading">
          <div className="section-heading">
            <span className="step-number">01</span>
            <div>
              <h2 id="details-heading">Poll details</h2>
              <p>Give the plan a name people will recognize.</p>
            </div>
          </div>

          <div className="field-group">
            <label htmlFor="poll-title">What are you planning?</label>
            <input
              id="poll-title"
              type="text"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Team dinner, project kickoff..."
              maxLength={100}
              required
              autoFocus
            />
          </div>

          <div className="field-group">
            <label htmlFor="organizer">Your name</label>
            <input
              id="organizer"
              type="text"
              value={organizer}
              onChange={(event) => setOrganizer(event.target.value)}
              placeholder="How participants will see you"
              maxLength={60}
              required
            />
          </div>

          <div className="field-group">
            <label htmlFor="location">Location <span>optional</span></label>
            <div className="input-with-icon">
              <MapPin size={18} />
              <input
                id="location"
                type="text"
                value={location}
                onChange={(event) => setLocation(event.target.value)}
                placeholder="Add a place or video call"
                maxLength={120}
              />
            </div>
          </div>

          <div className="field-group">
            <label htmlFor="description">Note <span>optional</span></label>
            <textarea
              id="description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Anything people should know?"
              maxLength={500}
              rows={4}
            />
          </div>
        </section>

        <section className="dates-panel" aria-labelledby="dates-heading">
          <div className="section-heading section-heading-row">
            <div className="heading-copy">
              <span className="step-number">02</span>
              <div>
                <h2 id="dates-heading">Date options</h2>
                <p>
                  {maxDates === null
                    ? 'Choose as many dates as you need, then add times if needed.'
                    : `Choose up to ${maxDates} dates, then add times if needed.`}
                </p>
              </div>
            </div>
            <span className={`date-count${atLimit ? ' full' : ''}`}>
              {selectedDates.length}{maxDates === null ? ' selected' : ` / ${maxDates}`}
            </span>
          </div>

          <CalendarPicker selectedDates={selectedDates} maxDates={maxDates} onToggle={toggleDate} />

          <div className="selected-options" aria-live="polite">
            {selectedDates.length === 0 ? (
              <div className="date-empty">
                <CalendarDays size={22} />
                <span>Selected dates will appear here</span>
              </div>
            ) : (
              selectedDates.map((date) => (
                <div className="selected-option" key={date}>
                  <div className="selected-date">
                    <CalendarDays size={18} />
                    <strong>{formatDate(date)}</strong>
                  </div>
                  <label className="time-input" title="Optional start time">
                    <Clock3 size={16} />
                    <input
                      type="time"
                      value={times[date] || ''}
                      onChange={(event) => setTimes((current) => ({ ...current, [date]: event.target.value }))}
                      aria-label={`Time for ${formatDate(date)}`}
                    />
                  </label>
                  <button
                    className="icon-button icon-button-danger"
                    type="button"
                    onClick={() => removeDate(date)}
                    aria-label={`Remove ${formatDate(date)}`}
                    title="Remove date"
                  >
                    <Trash2 size={17} />
                  </button>
                </div>
              ))
            )}
          </div>

          {atLimit && (
            <p className="limit-note">You&apos;ve reached the {maxDates}-date limit for this poll.</p>
          )}

          <div className="create-action">
            <div className="form-message" role="alert">{error}</div>
            <button className="button button-primary button-large" type="submit" disabled={submitting}>
              {submitting ? 'Creating poll...' : 'Create poll'}
              {!submitting && <ArrowRight size={19} />}
            </button>
          </div>
        </section>
      </form>
    </main>
  )
}