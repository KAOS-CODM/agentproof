import { useState } from 'react';
import { ApiError } from '../api';

interface Props {
  onLogin: (email: string, password: string) => Promise<void>;
  onRegister: (email: string, password: string) => Promise<void>;
  notice?: string | null;
}

/**
 * Minimal sign-in screen with account switching and registration.
 * Accounts are provisioned through the API; existing users may sign in,
 * new users may register, and any registered user may log out and sign
 * in as a different account.
 */
export function LoginScreen({ onLogin, notice, onRegister }: Props) {
  const [step, setStep] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onLogin(email, password);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401) {
          setError('Invalid email or password.');
        } else if (err.status === 403) {
          setError('Sign-in is not allowed from this origin.');
        } else {
          setError(err.message);
        }
      } else {
        setError('Unable to sign in. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRegisterSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      setSubmitting(false);
      return;
    }
    try {
      await onRegister(email, password);
      setStep('login');
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 409) {
          setError('Email already registered. Please sign in instead.');
        } else if (err.status === 400) {
          setError(err.message || 'Invalid request. Check email format and password length.');
        } else {
          setError(err.message || 'Registration failed. Please try again.');
        }
      } else {
        setError('Unable to register. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="app">
      <main className="app-main login-main">
        <div className="panel login-panel">
          <h1 className="app-title">AgentProof</h1>
          <p className="app-tagline">The trust layer for agentic commerce.</p>

          {notice && (
            <div className="error-banner" role="status">
              {notice}
            </div>
          )}
          {error && (
            <div className="error-banner" role="alert">
              {error}
            </div>
          )}

          {/* Step switcher */}
          <div className="step-switcher">
            <button
              className={`btn btn-secondary btn-small ${step === 'login' ? 'active' : ''}`}
              onClick={() => setStep('login')}
            >
              Sign in
            </button>
            <button
              className={`btn btn-secondary btn-small ${step === 'register' ? 'active' : ''}`}
              onClick={() => setStep('register')}
            >
              Register
            </button>
          </div>

          {step === 'login' ? (
            <form className="login-form" onSubmit={handleSubmit}>
              <label htmlFor="login-email" className="login-label">
                Email
              </label>
              <input
                id="login-email"
                className="login-input"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={submitting}
                required
              />

              <label htmlFor="login-password" className="login-label">
                Password
              </label>
              <input
                id="login-password"
                className="login-input"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={submitting}
                required
              />

              <button
                type="submit"
                className="btn btn-primary"
                disabled={submitting || !email.trim() || !password}
              >
                {submitting ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
          ) : (
            <form className="register-form" onSubmit={handleRegisterSubmit}>
              <label htmlFor="register-email" className="login-label">
                Email
              </label>
              <input
                id="register-email"
                className="login-input"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={submitting}
                required
              />

              <label htmlFor="register-password" className="login-label">
                Password
              </label>
              <input
                id="register-password"
                className="login-input"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={submitting}
                required
              />

              <label htmlFor="register-confirm-password" className="login-label">
                Confirm Password
              </label>
              <input
                id="register-confirm-password"
                className="login-input"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                disabled={submitting}
                required
              />

              <button
                type="submit"
                className="btn btn-primary"
                disabled={submitting || !email.trim() || !password || password !== confirmPassword}
              >
                {submitting ? 'Creating account…' : 'Create account'}
              </button>
            </form>
          )}

          <p className="login-hint">
            Accounts are provisioned through the application. Use the form above to sign in
            or register a new account.
          </p>
        </div>
      </main>
    </div>
  );
}
