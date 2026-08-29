import assert from 'node:assert/strict'
import test from 'node:test'
import { createAuthCallbackTransaction } from './auth-callback-transaction.ts'

function deferred() {
  let resolve
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function createHarness(overrides = {}) {
  const calls = []
  const transaction = createAuthCallbackTransaction({
    begin: () => calls.push('begin'),
    exchange: async () => {
      calls.push('exchange')
      return 'session'
    },
    persist: () => calls.push('persist'),
    loadOrganizations: async () => {
      calls.push('organizations')
      return 'organizations'
    },
    loadActiveOrganization: async () => {
      calls.push('active-organization')
      return 'active-organization'
    },
    commitOrganizations: () => calls.push('commit-organizations'),
    commitSession: () => calls.push('commit-session'),
    rollback: () => calls.push('rollback'),
    onFailure: () => calls.push('failure'),
    restartCli: () => calls.push('restart-cli'),
    ...overrides
  })
  return { calls, transaction }
}

void test('completes authentication without an authenticated event and publishes session last', async () => {
  const { calls, transaction } = createHarness()

  await transaction.complete('callback-token')

  assert.deepEqual(calls, [
    'begin',
    'exchange',
    'organizations',
    'active-organization',
    'commit-organizations',
    'persist',
    'commit-session',
    'restart-cli'
  ])
})

void test('coalesces duplicate callbacks while a transaction is active', async () => {
  const exchange = deferred()
  let exchanges = 0
  const { transaction } = createHarness({
    exchange: async () => {
      exchanges += 1
      return await exchange.promise
    }
  })

  const first = transaction.complete('callback-token')
  const second = transaction.complete('callback-token')
  exchange.resolve('session')
  await Promise.all([first, second])

  assert.equal(exchanges, 1)
})

void test('does not persist or publish an exchange that was cancelled', async () => {
  const exchange = deferred()
  const { calls, transaction } = createHarness({
    exchange: async () => {
      calls.push('exchange')
      return await exchange.promise
    }
  })

  const completion = transaction.complete('callback-token')
  transaction.cancel()
  exchange.resolve('session')
  await completion

  assert.deepEqual(calls, ['begin', 'exchange', 'rollback'])
})

void test('allows a new callback immediately after cancellation', async () => {
  const firstExchange = deferred()
  let exchanges = 0
  const { calls, transaction } = createHarness({
    exchange: async () => {
      exchanges += 1
      if (exchanges === 1) return await firstExchange.promise
      calls.push('second-exchange')
      return 'second-session'
    }
  })

  const first = transaction.complete('first-token')
  transaction.cancel()
  await transaction.complete('second-token')
  firstExchange.resolve('first-session')
  await first

  assert.equal(exchanges, 2)
  assert.equal(calls.filter((call) => call === 'commit-session').length, 1)
})

void test('rolls back without persisting when organization hydration fails', async () => {
  const { calls, transaction } = createHarness({
    loadOrganizations: async () => {
      throw new Error('organization unavailable')
    }
  })

  await assert.rejects(transaction.complete('callback-token'), /organization unavailable/)

  assert.equal(calls.includes('persist'), false)
  assert.equal(calls.includes('commit-session'), false)
  assert.deepEqual(calls.slice(-2), ['rollback', 'failure'])
})

void test('times out, rolls back, and releases the active transaction', async () => {
  const exchange = deferred()
  const calls = []
  const transaction = createAuthCallbackTransaction(
    {
      begin: () => calls.push('begin'),
      exchange: async () => await exchange.promise,
      persist: () => calls.push('persist'),
      loadOrganizations: async () => 'organizations',
      loadActiveOrganization: async () => 'active-organization',
      commitOrganizations: () => calls.push('commit-organizations'),
      commitSession: () => calls.push('commit-session'),
      rollback: () => calls.push('rollback'),
      onFailure: () => calls.push('failure'),
      restartCli: () => calls.push('restart-cli')
    },
    10
  )

  await assert.rejects(transaction.complete('callback-token'), /timed out/)
  assert.equal(transaction.isActive(), false)
  assert.deepEqual(calls, ['begin', 'rollback', 'failure'])

  exchange.resolve('late-session')
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(calls.includes('persist'), false)
})
