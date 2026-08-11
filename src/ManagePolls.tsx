import { useEffect, useState } from 'react'
import {
  AlertCircle,
  CalendarDays,
  Copy,
  ExternalLink,
  LoaderCircle,
  Settings2,
  Trash2,
  Users,
} from 'lucide-react'
import { getManagedPoll } from './api'
import { formatDate } from './date'
import {
  forgetManagedPoll,
  getManagedPollReferences,
  inviteUrl,
} from './managedPolls'
import type { ManagedPollReference, Poll } from './types'

interface ManagedPollItem {
  reference: ManagedPollReference
  poll?: Poll
  error?: string
}

interface ManagePollsProps {
  onNavigate: (path: string) => void
}

export default function ManagePolls({ onNavigate }: ManagePollsProps) {
  const [items, setItems] = useState<ManagedPollItem[]>([])
  const [loading, setLoading] = useState(true)
  const [copiedPollId, setCopiedPollId] = useState('')
  const [copyError, setCopyError] = useState('')

  useEffect(() => {
    let active = true
    const references = getManagedPollReferences()
    Promise.all(references.map(async (reference) => {
      try {
        return { reference, poll: await getManagedPoll(reference.id, reference.managementToken) }
      } catch (error) {
        return {
          reference,
          error: error instanceof Error ? error.message : 'Poll unavailable.',
        }
      }
    })).then((loadedItems) => {
      if (active) {
        setItems(loadedItems)
        setLoading(false)
      }
    })
    return () => {
      active = false
    }
  }, [])

  const copyInvite = async (pollId: string) => {
    try {
      await navigator.clipboard.writeText(inviteUrl(pollId))
      setCopyError('')
      setCopiedPollId(pollId)
      window.setTimeout(() => setCopiedPollId(''), 1800)
    } catch {
      setCopyError('Could not copy the invite link.')
    }
  }

  const removeReference = (pollId: string) => {
    forgetManagedPoll(pollId)
    setItems((current) => current.filter(({ reference }) => reference.id !== pollId))
  }

  return (
    <main className="manage-index-page">
      <div className="manage-titlebar">
        <div>
          <span className="eyebrow">Organizer workspace</span>
          <h1>My polls</h1>
        </div>
        <button className="button button-primary" type="button" onClick={() => onNavigate('/')}>
          <CalendarDays size={18} />
          Create poll
        </button>
      </div>

      {copyError && <div className="form-message" role="alert">{copyError}</div>}

      {loading ? (
        <div className="manage-loading"><LoaderCircle className="spin" size={25} /> Loading polls...</div>
      ) : items.length === 0 ? (
        <section className="manage-empty">
          <CalendarDays size={30} />
          <h2>No polls here yet</h2>
          <button className="button button-dark" type="button" onClick={() => onNavigate('/')}>
            Create your first poll
          </button>
        </section>
      ) : (
        <div className="managed-poll-list">
          {items.map(({ reference, poll, error }) => (
            <article className={`managed-poll-row${error ? ' unavailable' : ''}`} key={reference.id}>
              {poll ? (
                <>
                  <div className="managed-poll-main">
                    <span className={`poll-status ${poll.status}`}>{poll.status}</span>
                    <h2>{poll.title}</h2>
                    <div className="managed-poll-meta">
                      <span><CalendarDays size={15} /> {poll.options.length} dates</span>
                      <span><Users size={15} /> {poll.participants.length} responses</span>
                      <span>First option {formatDate(poll.options[0].date)}</span>
                    </div>
                  </div>
                  <div className="managed-poll-actions">
                    <button
                      className="button button-small button-dark"
                      type="button"
                      onClick={() => onNavigate(`/manage/${reference.id}/${reference.managementToken}`)}
                    >
                      <Settings2 size={16} /> Manage
                    </button>
                    <button
                      className="icon-button"
                      type="button"
                      onClick={() => onNavigate(`/p/${reference.id}`)}
                      aria-label={`Open ${poll.title}`}
                      title="Open poll"
                    >
                      <ExternalLink size={17} />
                    </button>
                    <button
                      className="icon-button"
                      type="button"
                      onClick={() => void copyInvite(reference.id)}
                      aria-label={`Copy invite for ${poll.title}`}
                      title={copiedPollId === reference.id ? 'Copied' : 'Copy invite'}
                    >
                      <Copy size={17} />
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="managed-poll-main">
                    <span className="managed-poll-error"><AlertCircle size={16} /> {error}</span>
                    <h2>Poll {reference.id}</h2>
                  </div>
                  <button
                    className="icon-button icon-button-danger"
                    type="button"
                    onClick={() => removeReference(reference.id)}
                    aria-label={`Remove poll ${reference.id}`}
                    title="Remove from My polls"
                  >
                    <Trash2 size={17} />
                  </button>
                </>
              )}
            </article>
          ))}
        </div>
      )}
    </main>
  )
}