import { useEffect, useState } from 'react'
import { CalendarCheck, Plus } from 'lucide-react'
import CreatePoll from './CreatePoll'
import PollPage from './PollPage'

function getPollId(pathname: string) {
  return pathname.match(/^\/p\/([a-z0-9]+)\/?$/)?.[1]
}

export default function App() {
  const [pathname, setPathname] = useState(window.location.pathname)

  useEffect(() => {
    const handlePopState = () => setPathname(window.location.pathname)
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
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
              <span className="plan-dot" /> Free - 9 dates max
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
      ) : (
        <CreatePoll onCreated={(id) => navigate(`/p/${id}`)} />
      )}
    </div>
  )
}