/**
 * Pre-install verification for the built browser half.
 *
 * The bundle is served outside the page's module graph, so a syntax or
 * loader-handshake mistake would only surface after a restart of the running
 * application. This script reproduces that handshake locally: it runs
 * `lib/client.js` in a VM that provides `window.__ModuleLoader__`, executes the
 * factory with a `require` that must stay unused, and then drives the plugin's
 * four subscription surfaces with fake services and a fake notification
 * platform. Run it after every build.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

const notifications = []
class FakeNotification {
  static permission = 'granted'
  static requestPermission() {
    return Promise.resolve('granted')
  }

  constructor(title, options) {
    this.title = title
    this.options = options
    this.onclick = null
    notifications.push(this)
  }
}

const stored = new Map([
  ['dsh-notify.options', JSON.stringify({ minRunMs: 0, replaceTurnEndMs: 0, selfTest: false, onlyWhenUnfocused: false })],
])
const gestureListeners = new Map()
let loaded
const windowStub = {
  __ModuleLoader__: { load: (spec) => { loaded = spec } },
  addEventListener: (name, handler) => { gestureListeners.set(name, handler) },
  removeEventListener: (name) => { gestureListeners.delete(name) },
  focus: () => { windowStub.focused = true },
  focused: false,
}
const context = vm.createContext({
  window: windowStub,
  document: { visibilityState: 'hidden', hasFocus: () => false },
  Notification: FakeNotification,
  localStorage: {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => { stored.set(key, value) },
  },
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Date,
  JSON,
  Error,
  Number,
  Object,
  Map,
  Set,
  Promise,
  Math,
})

vm.runInContext(code, context, { filename: 'lib/client.js' })

assert.ok(loaded, 'the bundle must register itself through window.__ModuleLoader__.load')
assert.equal(loaded.id, 'dsh-notify', 'the registered module id must be the package name')
assert.equal(typeof loaded.factory, 'function', 'the registration must carry a factory')

const namespace = loaded.factory(() => {
  throw new Error('the client half requested a module-table entry it never declared')
})
assert.equal(namespace.name, 'dsh-notify')
// The namespace comes from another realm, so compare its contents rather than
// its array identity (which belongs to that realm's Array prototype).
assert.equal(namespace.inject.join(','), 'remote,sessions,locale')
assert.equal(typeof namespace.apply, 'function')

const handlers = new Map()
const disposers = []
const opened = []
const listListeners = new Set()
// The store publishes list states without a job mirror; activation must survive
// that, which is the condition this standalone plugin first failed on.
let jobs
// Older clients REPLACE this field wholesale on every change, which is why the
// plugin must re-read it per poll instead of capturing the map once.
const uiSession = { pendingSnapshot: new Map() }
const fakeCtx = {
  remote: {
    $on: (event, handler) => {
      handlers.set(event, handler)
      return () => { handlers.delete(event) }
    },
  },
  sessions: {
    list: {
      getSnapshot: () => ({ byId: { s1: { displayTitle: '演示会话' } }, jobsBySession: jobs }),
      subscribe: (listener) => {
        listListeners.add(listener)
        return () => { listListeners.delete(listener) }
      },
    },
    open: (sessionId) => { opened.push(sessionId) },
  },
  locale: {
    register: () => () => {},
    bind: () => (key, params) => `${key}${params === undefined ? '' : `:${JSON.stringify(params)}`}`,
  },
  get: (name) => (name === 'uiSession' ? uiSession : undefined),
  effect: (callback) => {
    const dispose = callback()
    if (typeof dispose === 'function') disposers.push(dispose)
  },
}

namespace.apply(fakeCtx)

const status = handlers.get('api-session/status')
const error = handlers.get('api-session/error')
assert.equal(typeof status, 'function', 'the running-state event must be subscribed')
assert.equal(typeof error, 'function', 'the agent-error event must be subscribed')
assert.equal(listListeners.size, 1, 'the job mirror must be subscribed')

status('s1', true)
status('s1', false)
assert.equal(notifications.length, 1, 'a completed run produces one notification')
assert.match(notifications[0].options.body, /turnEnd/, 'the body comes from the locale dictionary')
// No `tag`: with one, this Electron build silently drops the toast.
assert.equal(notifications[0].options.tag, undefined, 'notifications carry no tag')
notifications[0].onclick()
assert.deepEqual(opened, ['s1'], 'clicking the notification opens its session')

error('s1', 'boom')
assert.equal(notifications.length, 2)
assert.match(notifications[1].options.body, /agentError/)

jobs = { s1: [{ id: 'bash-1', label: 'build', status: 'failed' }] }
for (const listener of listListeners) listener()
assert.equal(notifications.length, 3, 'a job that settles after the baseline notifies')
assert.match(notifications[2].options.body, /jobFailed/)

// The poll path: replace the whole map, as the real service does, and give the
// 1 Hz poll time to notice.
uiSession.pendingSnapshot = new Map([['s1', { key: 'approval-1', kind: 'approval', sessionId: 's1' }]])
await new Promise((resolve) => { setTimeout(resolve, 1_400) })
assert.equal(notifications.length, 4, 'a pending interaction added after activation notifies')
assert.match(notifications[3].options.body, /pendingInteraction/)

for (const dispose of disposers) dispose()
console.log(`verify-bundle: ok (${notifications.length} notifications driven, ${disposers.length} disposers released)`)
