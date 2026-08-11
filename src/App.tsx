import { useEffect, useState } from 'react'
import { CalendarCheck, ClipboardList, Plus } from 'lucide-react'
import { getConfig } from './api'
import CreatePoll from './CreatePoll'
import ManagePoll from './ManagePoll'
import ManagePolls from './ManagePolls'
import { rememberManagedPoll } from './managedPolls'
import PollPage from './PollPage'

function getRoute() {
  const route = window.location.hash.slice(1)
  return route.startsWith('/') ? route : '/'
}

function getPollId(route: string) {
  return route.match(/^\/p\/([a-z0-9]+)\/?$/)?.[1]
}

function getManagementRoute(route: string) {
  const match = route.match(/^\/manage\/([a-f0-9]{10})\/([a-f0-9]{48})\/?$/)
  return match ? { pollId: match[1], managementToken: match[2] } : null
}

export default function App() {
  const [route, setRoute] = useState(getRoute)
  const [maxDates, setMaxDates] = useState<number | null | undefined>(undefined)

  useEffect(() => {
    const handleHashChange = () => setRoute(getRoute())
    window.addEventListener('hashchange', handleHashChange)
    return () => window.removeEventListener('hashchange', handleHashChange)
  }, [])

  useEffect(() => {
    let active = true
    getConfig()
      .then((config) => {
        if (active) setMaxDates(config.maxDates)
      })
      .catch(() => {
        if (active) setMaxDates(null)
      })
    return () => {
      active = false
    }
  }, [])

  const navigate = (path: string) => {
    window.location.hash = path
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const pollId = getPollId(route)
  const managementRoute = getManagementRoute(route)
  const isManageIndex = /^\/manage\/?$/.test(route)

  let content
  if (managementRoute) {
    content = maxDates === undefined ? (
      <main className="status-page"><p>Loading date settings...</p></main>
    ) : (
      <ManagePoll
        key={managementRoute.pollId}
        pollId={managementRoute.pollId}
        managementToken={managementRoute.managementToken}
        maxDates={maxDates}
        onNavigate={navigate}
      />
    )
  } else if (isManageIndex) {
    content = <ManagePolls onNavigate={navigate} />
  } else if (pollId) {
    content = <PollPage key={pollId} pollId={pollId} onCreateNew={() => navigate('/')} />
  } else if (maxDates === undefined) {
    content = <main className="status-page"><p>Loading date settings...</p></main>
  } else {
    content = (
      <CreatePoll
        maxDates={maxDates}
        onCreated={(poll) => {
          const reference = { id: poll.id, managementToken: poll.managementToken }
          rememberManagedPoll(reference)
          navigate(`/manage/${reference.id}/${reference.managementToken}`)
        }}
      />
    )
  }

  return (
    <div className="app-shell">
      <header className="site-header">
        <div className="header-inner">
          <button className="brand" type="button" onClick={() => navigate('/')}>
            <span className="brand-mark" aria-hidden="true">
              <CalendarCheck size={22} strokeWidth={2.4} />
            </span>
            <span>Rally</span>
          </button>

          <div className="header-actions">
            <span className="plan-pill">
              <span className="plan-dot" />
              {maxDates === undefined ? 'Loading settings' : maxDates === null ? 'No date limit' : `${maxDates} dates max`}
            </span>
            {!isManageIndex && !managementRoute && (
              <button className="button button-small button-outline" type="button" onClick={() => navigate('/manage')}>
                <ClipboardList size={16} />
                <span className="header-action-label">My polls</span>
              </button>
            )}
            {route !== '/' && (
              <button className="button button-small button-dark" type="button" onClick={() => navigate('/')}>
                <Plus size={17} />
                <span className="header-action-label">New poll</span>
              </button>
            )}
          </div>
        </div>
      </header>
      {content}
    </div>
  )
}