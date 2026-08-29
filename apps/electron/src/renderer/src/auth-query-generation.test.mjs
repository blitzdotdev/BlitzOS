import assert from 'node:assert/strict'
import test from 'node:test'
import { createAuthQueryGeneration } from './auth-query-generation.ts'

void test('prevents an old auth query from persisting after the generation advances', () => {
  const generation = createAuthQueryGeneration()
  const requestGeneration = generation.capture()
  let persisted = false

  generation.advance()
  const committed = generation.commitIfCurrent(requestGeneration, () => {
    persisted = true
  })

  assert.equal(committed, false)
  assert.equal(persisted, false)
})

void test('commits the response while its auth query generation is current', () => {
  const generation = createAuthQueryGeneration()
  let persisted = false

  const committed = generation.commitIfCurrent(generation.capture(), () => {
    persisted = true
  })

  assert.equal(committed, true)
  assert.equal(persisted, true)
})
