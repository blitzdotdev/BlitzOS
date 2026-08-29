export type AuthCallbackTransactionDependencies<TSession, TOrganizations, TActiveOrganization> = {
  begin: () => void
  exchange: (token: string) => Promise<TSession>
  persist: (session: TSession) => void
  loadOrganizations: (session: TSession) => Promise<TOrganizations>
  loadActiveOrganization: (session: TSession) => Promise<TActiveOrganization>
  commitOrganizations: (
    organizations: TOrganizations,
    activeOrganization: TActiveOrganization
  ) => void
  commitSession: (session: TSession) => void
  rollback: () => void
  onFailure: (error: unknown) => void
  restartCli: () => void
}

export class AuthCallbackTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Authentication callback timed out after ${timeoutMs}ms`)
    this.name = 'AuthCallbackTimeoutError'
  }
}

export function createAuthCallbackTransaction<TSession, TOrganizations, TActiveOrganization>(
  dependencies: AuthCallbackTransactionDependencies<TSession, TOrganizations, TActiveOrganization>,
  timeoutMs = 30_000
) {
  let generation = 0
  let active: { token: string; promise: Promise<void> } | null = null

  const isCurrent = (candidate: number) => candidate === generation

  const complete = async (token: string): Promise<void> => {
    if (active?.token === token) {
      return await active.promise
    }
    if (active) {
      generation += 1
      active = null
      dependencies.rollback()
    }

    const transactionGeneration = ++generation
    dependencies.begin()
    const operation = (async () => {
      const session = await dependencies.exchange(token)
      if (!isCurrent(transactionGeneration)) return

      const organizations = await dependencies.loadOrganizations(session)
      if (!isCurrent(transactionGeneration)) return
      const activeOrganization = await dependencies.loadActiveOrganization(session)
      if (!isCurrent(transactionGeneration)) return

      dependencies.commitOrganizations(organizations, activeOrganization)
      dependencies.persist(session)
      dependencies.commitSession(session)

      dependencies.restartCli()
    })()
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => reject(new AuthCallbackTimeoutError(timeoutMs)), timeoutMs)
    })
    const transaction = Promise.race([operation, timeout]).finally(() => {
      if (timeoutId) clearTimeout(timeoutId)
    })

    active = { token, promise: transaction }
    try {
      await transaction
    } catch (error) {
      if (!isCurrent(transactionGeneration)) return
      generation += 1
      dependencies.rollback()
      dependencies.onFailure(error)
      throw error
    } finally {
      if (active?.promise === transaction) {
        active = null
      }
    }
  }

  return {
    complete,
    cancel: () => {
      generation += 1
      active = null
      dependencies.rollback()
    },
    getGeneration: () => generation,
    isCurrent,
    isActive: () => active !== null
  }
}
