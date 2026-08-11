import { useEffect, useState } from 'react'
import { CalendarCheck, Plus } from 'lucide-react'
import { getConfig } from './api'
import CreatePoll from './CreatePoll'
import PollPage from './PollPage'

function getRoute() {
  const route = window.location.hash.slice(1)
  return route.startsWith('/') ? route : '/'
}

function getPollId(route: string) {
  return route.match(/^\/p\/([a-z0-9]+)\/?$/)?.[1]
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
            {pollId && (
              <button className="button button-small button-dark" type="button" onClick={() => navigate('/')}>
                <Plus size={17} />
                New poll
              </button>
            )}
          </div>
        </div>
      </header>

      {pollId ? (
        <PollPage key={pollId} pollId={pollId} onCreateNew={() => navigate('/')} />
      ) : maxDates === undefined ? (
        <main className="status-page"><p>Loading date settings...</p></main>
      ) : (
        <CreatePoll maxDates={maxDates} onCreated={(id) => navigate(`/p/${id}`)} />
      )}
    </div>
  )
}