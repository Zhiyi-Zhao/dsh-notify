/**
 * Behavior of the pure trigger rules. These run against a fake clock, so no
 * test waits on real time and no timer is involved.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { TriggerEngine } from '../src/client/triggers.ts'

const MIN_RUN_MS = 10_000
const REPLACE_MS = 2_000

/** An engine whose clock only moves when the test moves it. */
function createHarness(): {
  readonly engine: TriggerEngine
  readonly advanceClock: (ms: number) => void
} {
  let now = 0
  const engine = new TriggerEngine({
    minRunMs: MIN_RUN_MS,
    replaceTurnEndMs: REPLACE_MS,
    now: () => now,
  })
  return { engine, advanceClock: (ms) => { now += ms } }
}

test('a run shorter than minRunMs produces no notification', () => {
  const { engine, advanceClock } = createHarness()
  engine.onAgentStatus('s1', true)
  advanceClock(MIN_RUN_MS - 1)
  assert.deepEqual(engine.onAgentStatus('s1', false), [])
  advanceClock(REPLACE_MS)
  assert.deepEqual(engine.due(), [])
})

test('a long run produces one turn-end notice once the replace window elapses', () => {
  const { engine, advanceClock } = createHarness()
  engine.onAgentStatus('s1', true)
  advanceClock(MIN_RUN_MS)
  assert.deepEqual(engine.onAgentStatus('s1', false), [])
  assert.deepEqual(engine.due(), [], 'the notice waits out the replace window')
  assert.equal(engine.nextDueAt(), MIN_RUN_MS + REPLACE_MS)
  advanceClock(REPLACE_MS)
  assert.deepEqual(engine.due(), [{ kind: 'turn-end', sessionId: 's1' }])
  assert.equal(engine.nextDueAt(), undefined)
})

test('an idle session observed without a rising edge stays silent', () => {
  const { engine, advanceClock } = createHarness()
  assert.deepEqual(engine.onAgentStatus('s1', false), [])
  advanceClock(REPLACE_MS)
  assert.deepEqual(engine.due(), [])
})

test('an error replaces the deferred turn end of the same run', () => {
  const { engine, advanceClock } = createHarness()
  engine.onAgentStatus('s1', true)
  advanceClock(MIN_RUN_MS)
  engine.onAgentStatus('s1', false)
  const notices = engine.onAgentError('s1', 'provider refused the request')
  assert.deepEqual(notices, [
    { kind: 'agent-error', sessionId: 's1', detail: 'provider refused the request' },
  ])
  advanceClock(REPLACE_MS)
  assert.deepEqual(engine.due(), [], 'the superseded turn end never surfaces')
})

test('an error observed before the run ends suppresses its turn end', () => {
  const { engine, advanceClock } = createHarness()
  engine.onAgentStatus('s1', true)
  advanceClock(MIN_RUN_MS)
  engine.onAgentError('s1', 'boom')
  assert.deepEqual(engine.onAgentStatus('s1', false), [])
  advanceClock(REPLACE_MS)
  assert.deepEqual(engine.due(), [])
})

test('a pending interaction replaces the deferred turn end', () => {
  const { engine, advanceClock } = createHarness()
  engine.onPendingInteractions(new Map())
  engine.onAgentStatus('s1', true)
  advanceClock(MIN_RUN_MS)
  engine.onAgentStatus('s1', false)
  const notices = engine.onPendingInteractions(new Map([['s1', { key: 'approval-1' }]]))
  assert.deepEqual(notices, [{ kind: 'pending-interaction', sessionId: 's1' }])
  advanceClock(REPLACE_MS)
  assert.deepEqual(engine.due(), [])
})

test('a turn end that follows a pending interaction is suppressed', () => {
  const { engine, advanceClock } = createHarness()
  engine.onPendingInteractions(new Map())
  engine.onAgentStatus('s1', true)
  advanceClock(MIN_RUN_MS)
  engine.onPendingInteractions(new Map([['s1', { key: 'approval-1' }]]))
  assert.deepEqual(engine.onAgentStatus('s1', false), [])
  advanceClock(REPLACE_MS)
  assert.deepEqual(engine.due(), [])
})

test('the first job snapshot is a baseline and later settlements notify', () => {
  const { engine } = createHarness()
  assert.deepEqual(
    engine.onJobs({ s1: [{ id: 'bash-1', label: 'npm test', status: 'completed' }] }),
    [],
    'a job already settled when the page attached is not news',
  )
  assert.deepEqual(
    engine.onJobs({ s1: [{ id: 'bash-1', label: 'npm test', status: 'running' }] }),
    [],
  )
  assert.deepEqual(
    engine.onJobs({ s1: [{ id: 'bash-1', label: 'npm test', status: 'completed' }] }),
    [{ kind: 'job-settled', sessionId: 's1', detail: 'npm test', jobStatus: 'completed' }],
  )
})

test('a settled job is reported once even when its row disappears and returns', () => {
  const { engine } = createHarness()
  engine.onJobs({})
  engine.onJobs({ s1: [{ id: 'bash-1', label: 'build', status: 'failed' }] })
  assert.deepEqual(engine.onJobs({}), [])
  assert.deepEqual(engine.onJobs({ s1: [{ id: 'bash-1', label: 'build', status: 'failed' }] }), [])
})

test('failed and killed jobs carry their settled status', () => {
  const { engine } = createHarness()
  engine.onJobs({})
  assert.deepEqual(
    engine.onJobs({
      s1: [
        { id: 'bash-1', label: 'build', status: 'failed' },
        { id: 'bash-2', label: 'serve', status: 'killed' },
      ],
    }),
    [
      { kind: 'job-settled', sessionId: 's1', detail: 'build', jobStatus: 'failed' },
      { kind: 'job-settled', sessionId: 's1', detail: 'serve', jobStatus: 'killed' },
    ],
  )
})

test('a missing job mirror is read as empty', () => {
  const { engine } = createHarness()
  assert.deepEqual(engine.onJobs(undefined), [])
  assert.deepEqual(engine.onJobs(undefined), [])
  assert.deepEqual(
    engine.onJobs({ s1: [{ id: 'bash-1', label: 'build', status: 'completed' }] }),
    [{ kind: 'job-settled', sessionId: 's1', detail: 'build', jobStatus: 'completed' }],
  )
})

test('a pending interaction is reported once while it stays pending', () => {
  const { engine } = createHarness()
  engine.onPendingInteractions(new Map())
  const snapshot = new Map([['s1', { key: 'question-1' }]])
  assert.deepEqual(engine.onPendingInteractions(snapshot), [
    { kind: 'pending-interaction', sessionId: 's1' },
  ])
  assert.deepEqual(engine.onPendingInteractions(snapshot), [])
  assert.deepEqual(
    engine.onPendingInteractions(new Map([['s1', { key: 'question-2' }]])),
    [{ kind: 'pending-interaction', sessionId: 's1' }],
    'a different interaction is a new event',
  )
})
