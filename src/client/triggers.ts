/**
 * Pure trigger rules for `dsh-notify`.
 *
 * The class folds client-observed facts — agent running state, agent errors,
 * the background-job mirror, and pending user interactions — into the
 * notifications the plugin should raise. It owns no clock, no timer, and no
 * DOM: the caller supplies `now` and drives `due()`, so every rule here is
 * directly testable.
 */

/** Notification kinds this plugin raises. */
export type NoticeKind = 'turn-end' | 'agent-error' | 'job-settled' | 'pending-interaction'

/** Background-job lifecycle states the client mirror publishes. */
export type JobStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed'

/** One notification the caller should show. */
export interface Notice {
  readonly kind: NoticeKind
  readonly sessionId: string
  /** Job label, or the agent error message, when the kind carries one. */
  readonly detail?: string
  /** Settled job status; present on `job-settled`. */
  readonly jobStatus?: JobStatus
}

/** One background-job row, as the job rules read it. */
export interface JobRow {
  readonly id: string
  readonly label: string
  readonly status: JobStatus
}

/** One pending interaction, as the pending rules read it. */
export interface PendingRow {
  /** Domain-owned identity of the interaction; stable while it stays pending. */
  readonly key: string
}

/** Tunables and clock the engine reads. */
export interface TriggerOptions {
  /** A completed run shorter than this is not worth a notification. */
  readonly minRunMs: number
  /**
   * How long a turn-end notice waits before it is shown. The wait is what lets
   * an error or a pending interaction that belongs to the same run replace it,
   * so one stopped agent never produces two notifications.
   */
  readonly replaceTurnEndMs: number
  readonly now: () => number
}

/** One deferred turn-end notice. */
interface DeferredTurnEnd {
  readonly notice: Notice
  readonly dueAt: number
}

/** Whether a job status is terminal. */
function isSettled(status: JobStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed'
}

/** Fold client-observed facts into notifications. */
export class TriggerEngine {
  private readonly options: TriggerOptions
  /** Wall-clock start of the run currently in flight, per session. */
  private readonly runStartedAt = new Map<string, number>()
  /** Turn-end notices waiting out {@link TriggerOptions.replaceTurnEndMs}. */
  private readonly deferred = new Map<string, DeferredTurnEnd>()
  /** Sessions whose in-flight run already reported an error. */
  private readonly errored = new Set<string>()
  /** Until this instant, a turn-end for the session is replaced by a better notice. */
  private readonly replaceUntil = new Map<string, number>()
  /** Settled-job identities already reported, so a reappearing row stays silent. */
  private readonly notifiedJobs = new Set<string>()
  /** Last observed status per session and job id. */
  private readonly seenJobs = new Map<string, Map<string, JobStatus>>()
  private jobsBaselined = false
  /** Pending-interaction identities already observed, keyed by session and domain key. */
  private readonly seenPending = new Set<string>()
  private pendingBaselined = false

  /** @param options - clock and thresholds. */
  constructor(options: TriggerOptions) {
    this.options = options
  }

  /**
   * Fold one agent running-state change.
   * @param sessionId - session whose agent changed state.
   * @param running - current agent running state.
   * @returns notices to show now; a qualifying turn end is deferred instead.
   */
  onAgentStatus(sessionId: string, running: boolean): readonly Notice[] {
    if (running) {
      // A new run owns its own outcome: nothing observed for the previous one
      // may suppress it.
      this.runStartedAt.set(sessionId, this.options.now())
      this.errored.delete(sessionId)
      this.replaceUntil.delete(sessionId)
      return []
    }
    const startedAt = this.runStartedAt.get(sessionId)
    this.runStartedAt.delete(sessionId)
    // No observed rising edge means this session was already idle when the
    // client attached; a completion nobody watched finish is not news.
    if (startedAt === undefined) return []
    const now = this.options.now()
    if (now - startedAt < this.options.minRunMs) return []
    if (this.errored.delete(sessionId)) return []
    const replaceUntil = this.replaceUntil.get(sessionId)
    if (replaceUntil !== undefined && now <= replaceUntil) return []
    this.deferred.set(sessionId, {
      notice: { kind: 'turn-end', sessionId },
      dueAt: now + this.options.replaceTurnEndMs,
    })
    return []
  }

  /**
   * Fold one agent error report.
   * @param sessionId - session whose run failed.
   * @param message - agent error text.
   * @returns the error notice; a deferred turn-end for the same run is dropped.
   */
  onAgentError(sessionId: string, message: string): readonly Notice[] {
    const now = this.options.now()
    this.errored.add(sessionId)
    this.replaceUntil.set(sessionId, now + this.options.replaceTurnEndMs)
    this.deferred.delete(sessionId)
    return [{ kind: 'agent-error', sessionId, detail: message }]
  }

  /**
   * Fold one background-job mirror snapshot.
   * @param snapshot - visible jobs per session, as the client list mirror publishes them.
   * A missing mirror reads as empty: the list store publishes states without one,
   * and a notification rule must never throw into its store subscriber.
   * @returns one notice per job that settled since the previous snapshot.
   */
  onJobs(snapshot: Readonly<Record<string, readonly JobRow[] | undefined>> | undefined): readonly Notice[] {
    const mirror = snapshot ?? {}
    const notices: Notice[] = []
    const next = new Map<string, Map<string, JobStatus>>()
    for (const sessionId of Object.keys(mirror)) {
      const byId = new Map<string, JobStatus>()
      for (const row of mirror[sessionId] ?? []) {
        byId.set(row.id, row.status)
        // The first snapshot is the baseline: jobs that were already settled
        // when the client attached are not news.
        if (!this.jobsBaselined) continue
        if (!isSettled(row.status) || this.seenJobs.get(sessionId)?.get(row.id) === row.status) continue
        const identity = `${sessionId}\u0000${row.id}\u0000${row.status}`
        if (this.notifiedJobs.has(identity)) continue
        this.notifiedJobs.add(identity)
        notices.push({ kind: 'job-settled', sessionId, detail: row.label, jobStatus: row.status })
      }
      next.set(sessionId, byId)
    }
    this.seenJobs.clear()
    for (const [sessionId, byId] of next) this.seenJobs.set(sessionId, byId)
    this.jobsBaselined = true
    return notices
  }

  /**
   * Fold one pending-interaction snapshot.
   * @param snapshot - the effective pending interaction per session, when one exists.
   * @returns one notice per interaction that appeared since the previous snapshot.
   */
  onPendingInteractions(snapshot: ReadonlyMap<string, PendingRow | undefined>): readonly Notice[] {
    const notices: Notice[] = []
    const seen = new Set<string>()
    const now = this.options.now()
    for (const [sessionId, interaction] of snapshot) {
      if (interaction === undefined) continue
      const identity = `${sessionId}\u0000${interaction.key}`
      seen.add(identity)
      if (!this.pendingBaselined || this.seenPending.has(identity)) continue
      notices.push({ kind: 'pending-interaction', sessionId })
      // The interaction, not the idle agent, is what the user must act on.
      this.replaceUntil.set(sessionId, now + this.options.replaceTurnEndMs)
      this.deferred.delete(sessionId)
    }
    this.seenPending.clear()
    for (const identity of seen) this.seenPending.add(identity)
    this.pendingBaselined = true
    return notices
  }

  /**
   * Take turn-end notices whose deferral has elapsed.
   * @returns notices that are due at the current clock reading.
   */
  due(): readonly Notice[] {
    const now = this.options.now()
    const notices: Notice[] = []
    for (const [sessionId, entry] of [...this.deferred]) {
      if (entry.dueAt > now) continue
      this.deferred.delete(sessionId)
      notices.push(entry.notice)
    }
    return notices
  }

  /**
   * Earliest deferral deadline.
   * @returns the deadline in wall-clock milliseconds, or undefined when no turn end waits.
   */
  nextDueAt(): number | undefined {
    let earliest: number | undefined
    for (const entry of this.deferred.values()) {
      if (earliest === undefined || entry.dueAt < earliest) earliest = entry.dueAt
    }
    return earliest
  }
}
