import { useEffect, useState } from 'react'
import { CalendarCheck, ClipboardList, Plus, UserRound } from 'lucide-react'
import { ApiError, claimAccountPoll, getAccountSession, getConfig, logoutAccount } from './api'
import AccountPage from './AccountPage'
import { clearAuthSession, getSessionToken, storeAuthSession } from './auth'
import { bundledPublicConfig } from './config'
import CreatePoll from './CreatePoll'
import ManagePoll from './ManagePoll'
import ManagePolls from './ManagePolls'
import { getManagedPollReferences, rememberManagedPoll } from './managedPolls'
import PollPage from './PollPage'
import type { AccountUser, AuthSession, PublicInstanceConfig } from './types'

function getRoute() {
  const route = window.location.hash.slice(1)
  return route.startsWith('/') ? route : '/'
}

function getPollId(route: string) {
  return route.match(/^\/p\/([a-z0-9]+)\/?$/)?.[1]
}

function getManagementRoute(route: string) {
  const match = route.match(/^\/manage\/([a-f0-9]{10})(?:\/([a-f0-9]{48}))?\/?$/)
  return match ? { pollId: match[1], managementToken: match[2] || '' } : null
}

export default function App() {
  const [route, setRoute] = useState(getRoute)
  const [config, setConfig] = useState<PublicInstanceConfig>()
  const [currentUser, setCurrentUser] = useState<AccountUser | null>(null)

  useEffect(() => {
    const handleHashChange = () => setRoute(getRoute())
    window.addEventListener('hashchange', handleHashChange)
    return () => window.removeEventListener('hashchange', handleHashChange)
  }, [])

  useEffect(() => {
    if (!config) return
    if (config.accounts.mode === 'disabled') {
      clearAuthSession()
      setCurrentUser(null)
      return
    }
    const sessionToken = getSessionToken()
    if (!sessionToken) return
    let active = true
    getAccountSession()
      .then(({ user }) => {
        if (active && getSessionToken() === sessionToken) setCurrentUser(user)
      })
      .catch((error: unknown) => {
        if (!(error instanceof ApiError) || error.status !== 401) return
        if (getSessionToken() === sessionToken) {
          clearAuthSession()
          if (active) setCurrentUser(null)
        }
      })
    return () => {
      active = false
    }
  }, [config])

  useEffect(() => {
    let active = true
    getConfig()
      .then((loadedConfig) => {
        if (active) setConfig(loadedConfig)
      })
      .catch(() => {
        if (active) setConfig(bundledPublicConfig)
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
  const savedManagementToken = managementRoute && !managementRoute.managementToken
    ? getManagedPollReferences().find(({ id }) => id === managementRoute.pollId)?.managementToken
    : undefined
  const isManageIndex = /^\/manage\/?$/.test(route)
  const isAccount = /^\/account\/?$/.test(route)
  const maxDates = config?.polls.maxDates
  const accountsEnabled = config?.accounts.mode !== 'disabled'
  const registrationOpen = config?.accounts.registration === 'open'

  const authenticated = async (session: AuthSession) => {
    storeAuthSession(session)
    setCurrentUser(session.user)
    await Promise.allSettled(getManagedPollReferences().map(({ id, managementToken }) => (
      claimAccountPoll(id, managementToken)
    )))
    navigate('/manage')
  }

  const signOut = async () => {
    try {
      await logoutAccount()
    } finally {
      clearAuthSession()
      setCurrentUser(null)
      navigate('/')
    }
  }

  let content
  if (isAccount && config?.accounts.mode === 'disabled') {
    content = (
      <main className="status-page">
        <h1>Accounts are disabled</h1>
        <button className="button button-dark" type="button" onClick={() => navigate('/manage')}>
          Open My polls
        </button>
      </main>
    )
  } else if (isAccount) {
    content = (
      <AccountPage
        user={currentUser}
        registrationOpen={registrationOpen}
        allowAnonymous={config?.accounts.mode === 'optional'}
        onAuthenticated={authenticated}
        onSignOut={signOut}
        onNavigate={navigate}
      />
    )
  } else if (managementRoute) {
    content = config === undefined ? (
      <main className="status-page"><p>Loading date settings...</p></main>
    ) : (
      <ManagePoll
        key={managementRoute.pollId}
        pollId={managementRoute.pollId}
        managementToken={managementRoute.managementToken || savedManagementToken}
        maxDates={config.polls.maxDates}
        onNavigate={navigate}
      />
    )
  } else if (isManageIndex) {
    content = <ManagePolls user={currentUser} onNavigate={navigate} />
  } else if (pollId) {
    content = <PollPage key={pollId} pollId={pollId} onCreateNew={() => navigate('/')} />
  } else if (config === undefined) {
    content = <main className="status-page"><p>Loading date settings...</p></main>
  } else if (config.accounts.mode === 'required' && !currentUser) {
    content = (
      <AccountPage
        user={null}
        registrationOpen={registrationOpen}
        allowAnonymous={false}
        onAuthenticated={authenticated}
        onSignOut={signOut}
        onNavigate={navigate}
      />
    )
  } else {
    content = (
      <CreatePoll
        maxDates={config.polls.maxDates}
        onCreated={(poll) => {
          const reference = { id: poll.id, managementToken: poll.managementToken }
          rememberManagedPoll(reference)
          navigate(currentUser
            ? `/manage/${reference.id}`
            : `/manage/${reference.id}/${reference.managementToken}`)
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
            <span>{config?.site.name || bundledPublicConfig.site.name}</span>
          </button>

          <div className="header-actions">
            <span className="plan-pill">
              <span className="plan-dot" />
              {config === undefined ? 'Loading settings' : maxDates === null ? 'No date limit' : `${maxDates} dates max`}
            </span>
            {!isManageIndex && !managementRoute && (
              <button className="button button-small button-outline" type="button" onClick={() => navigate('/manage')}>
                <ClipboardList size={16} />
                <span className="header-action-label">My polls</span>
              </button>
            )}
            {accountsEnabled && !isAccount && (
              <button className="button button-small button-outline" type="button" onClick={() => navigate('/account')}>
                <UserRound size={16} />
                <span className="header-action-label">{currentUser?.name || 'Sign in'}</span>
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