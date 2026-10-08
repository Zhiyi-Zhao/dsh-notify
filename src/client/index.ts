/**
 * Browser half of `dsh-notify`.
 *
 * The plugin raises operating-system notifications for the four moments a DSH
 * user needs to look away from the window and come back: a turn finished, a
 * turn failed, a background job settled, and an agent that is waiting for
 * confirmation. Notifications are rendered by the browser's own notification
 * platform, so they land in the Windows Action Center, macOS Notification
 * Center, or the Linux notification daemon, and the plugin works in both the
 * desktop shell and a plain browser window.
 */

import { en, NS, zh } from './locales.ts'
import { TriggerEngine, type Notice, type PendingRow } from './triggers.ts'
import type { ClientContext, Observable, PendingInteraction, Translate } from './types.ts'

/** Plugin name. */
export const name = 'dsh-notify'

/** Client services the notification rules read. */
export const inject = ['remote', 'sessions', 'locale']

/** Runtime tunables, overridable through `localStorage['dsh-notify.options']`. */
interface NotifyOptions {
  /** Stay silent while the window is focused and visible. */
  readonly onlyWhenUnfocused: boolean
  /** Completed runs shorter than this are not worth a notification. */
  readonly minRunMs: number
  /** Show notifications without the platform sound. */
  readonly silent: boolean
  /** Show one notification on first load, so the installation is visible. */
  readonly selfTest: boolean
  /** How long a turn-end notice waits for a better notice about the same run. */
  readonly replaceTurnEndMs: number
}

const DEFAULT_OPTIONS: NotifyOptions = {
  onlyWhenUnfocused: true,
  minRunMs: 10_000,
  silent: false,
  selfTest: true,
  replaceTurnEndMs: 2_000,
}

const OPTIONS_KEY = 'dsh-notify.options'
const SELF_TEST_KEY = 'dsh-notify.selfTestShown'

/** The slice of the Web Notification API this plugin uses. */
interface NotificationCtor {
  new (title: string, options?: { body?: string; silent?: boolean; tag?: string }): { onclick: (() => void) | null }
  readonly permission: 'default' | 'denied' | 'granted'
  requestPermission(): Promise<'default' | 'denied' | 'granted'>
}

/** Closed-union exhaustiveness fence. */
function assertNever(value: never): never {
  throw new Error(`dsh-notify: unhandled notice kind ${JSON.stringify(value)}`)
}

/** Notification body for one notice. */
function bodyFor(notice: Notice, sessionTitle: string, t: Translate): string {
  switch (notice.kind) {
    case 'turn-end':
      return t('notification.turnEnd', { title: sessionTitle })
    case 'agent-error':
      return t('notification.agentError', { title: sessionTitle })
    case 'pending-interaction':
      return t('notification.pendingInteraction', { title: sessionTitle })
    case 'job-settled': {
      const label = notice.detail ?? sessionTitle
      if (notice.jobStatus === 'failed') return t('notification.jobFailed', { label })
      if (notice.jobStatus === 'killed') return t('notification.jobKilled', { label })
      return t('notification.jobCompleted', { label })
    }
    default:
      return assertNever(notice.kind)
  }
}

/**
 * Read one stored value.
 * @param key - storage key.
 * @returns the stored string, or null when absent or storage is unavailable.
 */
function readStored(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null
  } catch {
    // Storage is unavailable only when the page forbids it (privacy modes);
    // callers fall back to defaults, so nothing else can reach this.
    return null
  }
}

/**
 * Store one value, best effort.
 * @param key - storage key.
 * @param value - value to store.
 */
function writeStored(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value)
  } catch {
    // Same unavailable-storage case as readStored: the flag only suppresses a
    // repeat self-test, so losing it is harmless.
  }
}

/** Narrow one unknown override to a boolean. */
function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** Milliseconds between polls of the pending-interaction map on clients that publish no observable. */
const PENDING_POLL_MS = 1_000

/**
 * Client service members that differ across harness versions.
 *
 * `pendingInteractions` is the observable a current client publishes; older
 * clients keep only the live `pendingSnapshot` map. Reading whichever exists is
 * what keeps this plugin usable on both.
 */
interface UiSessionView {
  readonly pendingInteractions?: Observable<ReadonlyMap<string, PendingInteraction>>
  readonly pendingSnapshot?: ReadonlyMap<string, unknown>
}

/**
 * Normalize one pending-interaction value into an engine row.
 * @param value - domain-owned pending value.
 * @returns a row carrying a stable identity.
 */
function normalizePendingRow(value: unknown): PendingRow {
  const record = (value ?? {}) as { key?: unknown; kind?: unknown }
  return { key: typeof record.key === 'string' ? record.key : String(record.kind ?? 'pending') }
}

/**
 * Normalize a pending-interaction snapshot.
 * @param snapshot - session-keyed pending values, as a Map or a plain record.
 * @returns the rule engine's read view.
 */
function normalizePending(snapshot: unknown): ReadonlyMap<string, PendingRow> {
  const source = snapshot instanceof Map
    ? [...snapshot.entries()]
    : Object.entries((snapshot ?? {}) as Record<string, unknown>)
  const normalized = new Map<string, PendingRow>()
  for (const [sessionId, value] of source) {
    if (value === undefined || value === null) continue
    normalized.set(String(sessionId), normalizePendingRow(value))
  }
  return normalized
}

/** Narrow one unknown override to a finite, non-negative number. */
function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/**
 * Resolve the runtime tunables.
 * @returns stored overrides merged over {@link DEFAULT_OPTIONS}.
 */
function readOptions(): NotifyOptions {
  const raw = readStored(OPTIONS_KEY)
  if (raw === null) return DEFAULT_OPTIONS
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return DEFAULT_OPTIONS
    const record = parsed as Record<string, unknown>
    return {
      onlyWhenUnfocused: booleanOr(record.onlyWhenUnfocused, DEFAULT_OPTIONS.onlyWhenUnfocused),
      minRunMs: numberOr(record.minRunMs, DEFAULT_OPTIONS.minRunMs),
      silent: booleanOr(record.silent, DEFAULT_OPTIONS.silent),
      selfTest: booleanOr(record.selfTest, DEFAULT_OPTIONS.selfTest),
      replaceTurnEndMs: numberOr(record.replaceTurnEndMs, DEFAULT_OPTIONS.replaceTurnEndMs),
    }
  } catch (error) {
    // A malformed override is the only way JSON.parse throws here; defaults are
    // the safe reading of an unreadable preference.
    console.warn('[dsh-notify] ignoring malformed options override', error)
    return DEFAULT_OPTIONS
  }
}

/**
 * Install the notification rules.
 *
 * The whole activation is contained: a client entry that throws fails the Web
 * boot audit, and the desktop shell treats that audit failure as fatal. A
 * notification plugin must degrade to "off" rather than take the application
 * down with it.
 * @param ctx - client context.
 */
export function apply(ctx: ClientContext): void {
  try {
    activate(ctx)
  } catch (error) {
    console.error('[dsh-notify] activation failed; notifications stay off', error)
  }
}

/**
 * Wire the notification rules onto the client services.
 * @param ctx - client context.
 */
function activate(ctx: ClientContext): void {
  const Ctor = (globalThis as { Notification?: NotificationCtor }).Notification
  if (Ctor === undefined) {
    console.warn('[dsh-notify] this environment has no Web Notification API; notifications stay off')
    return
  }

  const options = readOptions()
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-notify: dictionaries')
  const t = ctx.locale.bind(NS)
  // Resolve every service once, here. `ctx.<service>` resolves against the
  // running fiber, so a callback that runs outside this plugin's fiber — a
  // store notification, a notification click, the deferral timer — must use
  // these captured values instead of reaching through `ctx` again.
  const remote = ctx.remote
  const sessions = ctx.sessions
  const list = sessions.list
  const engine = new TriggerEngine({
    minRunMs: options.minRunMs,
    replaceTurnEndMs: options.replaceTurnEndMs,
    now: () => Date.now(),
  })

  /** Display title of one session, from the client list mirror. */
  const sessionTitle = (sessionId: string): string => {
    const row = list.getSnapshot().byId?.[sessionId]
    return row?.displayTitle ?? t('notification.sessionFallback')
  }

  /** Show one notification. */
  const show = (notice: Notice): void => {
    if (Ctor.permission !== 'granted') return
    if (options.onlyWhenUnfocused
      && document.visibilityState === 'visible'
      && document.hasFocus()) return
    try {
      // Deliberately no `tag`: with one set, this Electron build hands the
      // notification to Windows and the toast never appears, while the same
      // call without a tag always arrives. Per-session replacement is the price.
      const notification = new Ctor(t('notification.title'), {
        body: bodyFor(notice, sessionTitle(notice.sessionId), t),
        silent: options.silent,
      })
      notification.onclick = () => {
        try {
          window.focus()
        } catch {
          // Focusing can be refused while the document is not active; opening
          // the session below still runs, so the click is never lost.
        }
        try {
          // Older clients expose no way to select a session from a plugin; the
          // click then only brings the window forward, which is still the point.
          sessions.open?.(notice.sessionId)
        } catch {
          // The session may have been archived or deleted since the notice; the
          // window is focused either way, and nothing else can reach this.
        }
      }
    } catch (error) {
      console.warn('[dsh-notify] could not show notification', error)
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined

  /** Show every notice just produced, then arm the deferral timer. */
  const pump = (notices: readonly Notice[]): void => {
    for (const notice of notices) show(notice)
    if (timer !== undefined) clearTimeout(timer)
    for (const notice of engine.due()) show(notice)
    const dueAt = engine.nextDueAt()
    timer = dueAt === undefined
      ? undefined
      : setTimeout(() => { pump([]) }, Math.max(0, dueAt - Date.now()))
  }

  ctx.effect(
    () => () => { if (timer !== undefined) clearTimeout(timer) },
    'dsh-notify: deferral timer',
  )

  ctx.effect(() => {
    const uiSession = ctx.get('uiSession') as UiSessionView | undefined
    const disposers: (() => void)[] = [
      remote.$on('api-session/status', (sessionId, running) => {
        pump(engine.onAgentStatus(sessionId, running))
      }),
      remote.$on('api-session/error', (sessionId, message) => {
        pump(engine.onAgentError(sessionId, message))
      }),
      list.subscribe(() => {
        pump(engine.onJobs(list.getSnapshot().jobsBySession))
      }),
    ]
    // Baseline before subscribing: jobs already settled when the page attached
    // are history, not news.
    engine.onJobs(list.getSnapshot().jobsBySession)

    // Sessions already running when this plugin activated are seeded, so a
    // reload during a turn does not lose that turn's completion notice.
    for (const [sessionId, row] of Object.entries(list.getSnapshot().byId ?? {})) {
      if (row?.running === true) engine.onAgentStatus(sessionId, true)
    }

    // Pending confirmations. Newer clients publish an observable
    // (`uiSession.pendingInteractions`); older clients replace the
    // `pendingSnapshot` field wholesale on every change, so that one is polled
    // and the field is re-read per poll rather than captured once.
    const pending = uiSession?.pendingInteractions
    if (pending !== undefined) {
      disposers.push(pending.subscribe(() => { pump(engine.onPendingInteractions(normalizePending(pending.getSnapshot()))) }))
      engine.onPendingInteractions(normalizePending(pending.getSnapshot()))
    } else if (uiSession !== undefined) {
      const read = (): ReadonlyMap<string, PendingRow> => normalizePending(uiSession.pendingSnapshot)
      engine.onPendingInteractions(read())
      const interval = setInterval(() => { pump(engine.onPendingInteractions(read())) }, PENDING_POLL_MS)
      disposers.push(() => { clearInterval(interval) })
    }
    return () => { for (const dispose of disposers) dispose() }
  }, 'dsh-notify: client subscriptions')

  /**
   * Show the one-time installation notification, once the platform allows it.
   * The desktop shell may report `default` until a permission request resolves,
   * so this also runs after the first granted request.
   */
  const maybeSelfTest = (): void => {
    if (!options.selfTest || Ctor.permission !== 'granted' || readStored(SELF_TEST_KEY) === '1') return
    try {
      new Ctor(t('notification.title'), { body: t('notification.selfTest'), silent: options.silent })
      writeStored(SELF_TEST_KEY, '1')
    } catch (error) {
      // The flag is written only on success, so a platform that refuses the
      // first notification retries on the next load instead of staying silent.
      console.warn('[dsh-notify] self-test notification failed', error)
    }
  }

  if (Ctor.permission === 'default') {
    // A browser window needs one user gesture before it may ask. The desktop
    // shell grants the request itself, so this path resolves on the first click.
    ctx.effect(() => {
      const request = (): void => {
        window.removeEventListener('pointerdown', request)
        window.removeEventListener('keydown', request)
        void Ctor.requestPermission().then(maybeSelfTest, () => {
          // A refused request leaves notifications off; every later rule checks
          // the permission again, so there is nothing else to undo here.
        })
      }
      window.addEventListener('pointerdown', request, { once: true })
      window.addEventListener('keydown', request, { once: true })
      return () => {
        window.removeEventListener('pointerdown', request)
        window.removeEventListener('keydown', request)
      }
    }, 'dsh-notify: permission request')
  }

  maybeSelfTest()
}
