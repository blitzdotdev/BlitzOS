import type { LocalProjectControlRequest } from '@lody/shared/message'
import { getIpcServiceDeps } from './ipc-service-deps'

type LocalProjectControlRequestWithoutMachine = LocalProjectControlRequest extends infer T
  ? T extends { machineId: unknown }
    ? Omit<T, 'machineId'>
    : never
  : never

export async function sendLocalProjectControl(
  request: LocalProjectControlRequest | LocalProjectControlRequestWithoutMachine,
  knownMachineId?: string
) {
  const unavailableResponse = {
    ok: false,
    type: request.type,
    error: 'daemon_unavailable',
    message: 'Local CLI daemon is unavailable. Run `npx lody start`.'
  } as const

  const { cliService } = getIpcServiceDeps()
  const machineId = knownMachineId ?? (await cliService.getLocalMachineId())
  if (!machineId) {
    return unavailableResponse
  }

  const requestWithMachineId = {
    ...request,
    machineId
  } as LocalProjectControlRequest
  const response = await cliService.sendLocalProjectControl(requestWithMachineId)
  if (response.ok || response.error !== 'machine_mismatch') {
    return response
  }

  const refreshedMachineId = await cliService.getLocalMachineId({ forceRefresh: true })
  if (!refreshedMachineId || refreshedMachineId === machineId) {
    return response
  }

  return await cliService.sendLocalProjectControl({
    ...request,
    machineId: refreshedMachineId
  } as LocalProjectControlRequest)
}
