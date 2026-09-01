import assert from 'node:assert/strict'
import net from 'node:net'
import test from 'node:test'
import { LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION } from '@lody/shared/local-loro-data-plane'
import { LoroDataPlaneRelay } from './loro-data-plane-relay.ts'

void test('does not probe the local data plane while local agents are disabled', async () => {
  let connectionAttempts = 0
  const relay = new LoroDataPlaneRelay('/unused/local-data-plane.sock', () => {
    connectionAttempts += 1
    const socket = new net.Socket()
    queueMicrotask(() => socket.emit('error', new Error('test socket unavailable')))
    return socket
  })
  const ping = {
    type: 'ping',
    protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION
  }

  relay.setEnabled(false)
  relay.send(ping)
  assert.equal(connectionAttempts, 0)

  relay.setEnabled(true)
  relay.send(ping)
  assert.equal(connectionAttempts, 1)

  relay.destroy()
  await Promise.resolve()
})
