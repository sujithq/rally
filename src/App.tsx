import { useEffect, useState } from 'react'
import { CalendarCheck, Plus } from 'lucide-react'
import { getConfig } from './api'
import CreatePoll from './CreatePoll'
import PollPage from './PollPage'

function getPollId(pathname: string) {
  return pathname.match(/^\/p\/([a-z0-9]+)\/?$/)?.[1]
}

export default function App() {
  const [pathname, setPathname] = useState(window.location.pathname)
  const [maxDates, setMaxDates] = useState<number | null | undefined>(undefined)

  useEffect(() => {
    const handlePopState = () => setPathname(window.location.pathname)
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
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
    window.history.pushState({}, '', path)
    setPathname(path)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const pollId = getPollId(pathname)

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
        <PollPage pollId={pollId} onCreateNew={() => navigate('/')} />
      ) : maxDates === undefined ? (
        <main className="status-page"><p>Loading date settings...</p></main>
      ) : (
        <CreatePoll maxDates={maxDates} onCreated={(id) => navigate(`/p/${id}`)} />
      )}
    </div>
  )
}