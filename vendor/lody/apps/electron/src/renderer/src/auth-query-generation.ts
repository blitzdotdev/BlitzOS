export function createAuthQueryGeneration() {
  let current = 0

  return {
    capture: () => current,
    advance: () => {
      current += 1
    },
    commitIfCurrent: (generation: number, commit: () => void): boolean => {
      if (generation !== current) return false
      commit()
      return true
    }
  }
}
