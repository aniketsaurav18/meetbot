import { useState, useEffect, useRef, useCallback } from 'react'
import './App.css'

type SessionStatus = 'QUEUED' | 'JOINING' | 'RECORDING' | 'DONE' | 'FAILED'

interface TranscriptChunk {
  id: string
  text: string
  receivedAt: string
  sequence?: number
}

interface SessionRecord {
  sessionId: string
  meetUrl: string
  botDisplayName: string
  status: SessionStatus
  createdAt: string
  updatedAt: string
  error?: string
  attemptsMade: number
  transcript: TranscriptChunk[]
}

const API_BASE = import.meta.env.VITE_API_BASE ?? ''

export default function App() {
  const [session, setSession] = useState<SessionRecord | null>(null)
  const [error, setError] = useState('')

  const reset = () => {
    setSession(null)
    setError('')
  }

  return (
    <div className="app">
      <header className="header">
        <h1>Meet Transcription Bot</h1>
        <p>Enter a Google Meet link to start live transcription</p>
      </header>

      {session ? (
        <SessionView session={session} onBack={reset} />
      ) : (
        <SubmitForm onCreated={setSession} error={error} setError={setError} />
      )}
    </div>
  )
}

/* ────────────────────── Submit Form ────────────────────── */

function SubmitForm({
  onCreated,
  error,
  setError,
}: {
  onCreated: (s: SessionRecord) => void
  error: string
  setError: (e: string) => void
}) {
  const [meetUrl, setMeetUrl] = useState('')
  const [botName, setBotName] = useState('Transcription Bot')
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setSubmitting(true)

    try {
      const res = await fetch(`${API_BASE}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meetUrl, botDisplayName: botName }),
      })

      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.error ?? `Request failed (${res.status})`)
      }

      onCreated(data.session)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="card">
      <form className="form" onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="meet-url">Google Meet URL</label>
          <input
            id="meet-url"
            type="url"
            required
            placeholder="https://meet.google.com/abc-defg-hij"
            value={meetUrl}
            onChange={(e) => setMeetUrl(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="bot-name">Bot Display Name</label>
          <input
            id="bot-name"
            type="text"
            required
            placeholder="Transcription Bot"
            value={botName}
            onChange={(e) => setBotName(e.target.value)}
          />
        </div>
        <button
          id="submit-session"
          type="submit"
          className="submit-btn"
          disabled={submitting}
        >
          {submitting ? 'Creating session…' : 'Start Transcription'}
        </button>
        {error && <p className="error-msg">{error}</p>}
      </form>
    </div>
  )
}

/* ────────────────────── Session View ────────────────────── */

function SessionView({
  session,
  onBack,
}: {
  session: SessionRecord
  onBack: () => void
}) {
  const transcriptRef = useRef<HTMLDivElement>(null)
  const [chunks, setChunks] = useState<TranscriptChunk[]>(session.transcript ?? [])
  const [status, setStatus] = useState<SessionStatus>(session.status)
  const [sessionError, setSessionError] = useState(session.error)

  const handleEvent = useCallback((event: MessageEvent, eventType: string) => {
    try {
      const data = JSON.parse(event.data)

      if (eventType === 'session' || eventType === 'status') {
        setStatus(data.status)
        if (data.error) setSessionError(data.error)
        if (data.transcript) setChunks(data.transcript)
      }

      if (eventType === 'transcript') {
        setStatus(data.status)
        if (data.chunk) {
          setChunks((prev) => [...prev, data.chunk])
        }
      }
    } catch {
      // ignore parse errors
    }
  }, [])

  useEffect(() => {
    const url = `${API_BASE}/sessions/${session.sessionId}/events`
    const es = new EventSource(url)

    const events = ['session', 'status', 'transcript'] as const
    for (const eventType of events) {
      es.addEventListener(eventType, (e) => handleEvent(e, eventType))
    }

    es.onerror = () => {
      // EventSource auto-reconnects; nothing to do
    }

    return () => es.close()
  }, [session.sessionId, handleEvent])

  // Auto-scroll transcript box
  useEffect(() => {
    const el = transcriptRef.current
    if (el) {
      el.scrollTop = el.scrollHeight
    }
  }, [chunks])

  const fullText = chunks.map((c) => c.text).join(' ')

  return (
    <div className="card">
      <div className="session-header">
        <h2>Session</h2>
        <button className="back-btn" onClick={onBack}>
          ← New session
        </button>
      </div>

      <div className="status-row">
        <span className={`status-badge status-${status}`}>
          <span className="dot" />
          {status}
        </span>
      </div>

      <p className="transcript-label">Live Transcript</p>
      <div className="transcript-box" ref={transcriptRef}>
        {fullText ? fullText : <span className="transcript-empty">Waiting for audio…</span>}
      </div>

      {sessionError && <div className="session-error">Error: {sessionError}</div>}
    </div>
  )
}
