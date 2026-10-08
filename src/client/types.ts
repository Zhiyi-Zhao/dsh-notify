/**
 * Narrow structural views of the client services this plugin reads.
 *
 * The upstream package would import the real service types; they are restated
 * here so the standalone bundle has no build-time dependency on the harness
 * type graph. Every member below was read off the owning service at the version
 * the README records.
 */

/** One session-list row, as far as notifications read it. */
export interface SessionListRow {
  /** Human-facing label: durable title, project basename, then session id. */
  readonly displayTitle: string
  /** Agent running state; absent on clients that do not project it into the list. */
  readonly running?: boolean
}

/** Client session-list state, as far as notifications read it. */
export interface SessionListState {
  readonly byId: Readonly<Record<string, SessionListRow | undefined>>
  /**
   * Visible background jobs per session, folded from the control stream. The
   * store publishes list states without this member, so every reader treats it
   * as optional.
   */
  readonly jobsBySession?: Readonly<Record<string, readonly JobRowView[] | undefined>>
}

/** One background-job row from the session-list mirror. */
export interface JobRowView {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
  readonly detail?: string
  readonly startedAt: number
  readonly finishedAt?: number
}

/** One pending interaction, as the registry publishes it. */
export interface PendingInteraction {
  readonly key: string
  readonly kind: string
  readonly sessionId: string
}

/** Bare observable source: a stable snapshot plus change notifications. */
export interface Observable<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** Translate function bound to one locale namespace. */
export interface Translate {
  (key: string, params?: Record<string, unknown>): string
}

/** The client context surface `dsh-notify` reads. */
export interface ClientContext {
  readonly remote: {
    $on(name: 'api-session/status', handler: (sessionId: string, running: boolean) => void): () => void
    $on(name: 'api-session/error', handler: (sessionId: string, message: string) => void): () => void
    $on(name: string, handler: (...args: never[]) => void): () => void
  }
  readonly sessions: {
    readonly list: Observable<SessionListState>
    /** Absent on older clients, which expose no plugin-facing session selection. */
    open?(sessionId: string): void
  }
  readonly locale: {
    register(ns: string, dictionaries: Record<string, Record<string, string>>): () => void
    bind(ns: string): Translate
  }
  /** Optional services are read through `get`; a missing one disables only its own trigger. */
  get(name: string): unknown
  effect(callback: () => void | (() => void), label?: string): void
}
