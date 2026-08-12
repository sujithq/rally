import { type FormEvent, useState } from 'react'
import { ArrowRight, ClipboardList, LogOut, UserRound } from 'lucide-react'
import { loginAccount, registerAccount } from './api'
import type { AccountUser, AuthSession } from './types'

interface AccountPageProps {
  user: AccountUser | null
  registrationOpen: boolean
  allowAnonymous: boolean
  onAuthenticated: (session: AuthSession) => Promise<void>
  onSignOut: () => Promise<void>
  onNavigate: (path: string) => void
}

export default function AccountPage({
  user,
  registrationOpen,
  allowAnonymous,
  onAuthenticated,
  onSignOut,
  onNavigate,
}: AccountPageProps) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  if (user) {
    return (
      <main className="account-page">
        <section className="account-panel account-summary">
          <span className="account-icon"><UserRound size={28} /></span>
          <div>
            <span className="eyebrow">Organizer account</span>
            <h1>{user.name}</h1>
            <p>{user.email}</p>
          </div>
          <div className="account-actions">
            <button className="button button-primary" type="button" onClick={() => onNavigate('/manage')}>
              <ClipboardList size={17} /> My polls
            </button>
            <button className="button button-outline" type="button" onClick={() => void onSignOut()}>
              <LogOut size={17} /> Sign out
            </button>
          </div>
        </section>
      </main>
    )
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      const session = mode === 'register'
        ? await registerAccount({ name, email, password })
        : await loginAccount({ email, password })
      await onAuthenticated(session)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not access your account.')
      setSubmitting(false)
    }
  }

  const changeMode = (nextMode: 'login' | 'register') => {
    setMode(nextMode)
    setPassword('')
    setError('')
  }

  return (
    <main className="account-page">
      <div className="account-heading">
        <span className="eyebrow">Organizer account</span>
        <h1>{mode === 'login' ? 'Welcome back.' : 'Create your account.'}</h1>
      </div>

      <section className="account-panel">
        <div className="auth-tabs" role="tablist" aria-label="Account action">
          <button
            className={mode === 'login' ? 'active' : ''}
            type="button"
            role="tab"
            aria-selected={mode === 'login'}
            onClick={() => changeMode('login')}
          >
            Sign in
          </button>
          {registrationOpen && (
            <button
              className={mode === 'register' ? 'active' : ''}
              type="button"
              role="tab"
              aria-selected={mode === 'register'}
              onClick={() => changeMode('register')}
            >
              Create account
            </button>
          )}
        </div>

        <form className="account-form" onSubmit={submit}>
          {mode === 'register' && (
            <div className="field-group">
              <label htmlFor="account-name">Your name</label>
              <input
                id="account-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoComplete="name"
                maxLength={60}
                required
              />
            </div>
          )}
          <div className="field-group">
            <label htmlFor="account-email">Email</label>
            <input
              id="account-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              maxLength={254}
              required
              autoFocus
            />
          </div>
          <div className="field-group">
            <label htmlFor="account-password">Password</label>
            <input
              id="account-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              minLength={mode === 'register' ? 10 : undefined}
              maxLength={128}
              required
            />
          </div>
          <div className="form-message" role="alert">{error}</div>
          <button className="button button-primary button-large" type="submit" disabled={submitting}>
            {submitting ? 'Please wait...' : mode === 'login' ? 'Sign in' : 'Create account'}
            {!submitting && <ArrowRight size={18} />}
          </button>
        </form>

        {allowAnonymous && (
          <button className="account-skip" type="button" onClick={() => onNavigate('/')}>
            Continue without an account
          </button>
        )}
      </section>
    </main>
  )
}