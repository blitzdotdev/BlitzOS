export class SaveTextConflictError extends Error {
  constructor(
    readonly conflict: string,
    readonly conflictId?: string,
    message = `save_conflict: ${conflict}`
  ) {
    super(message);
    this.name = 'SaveTextConflictError';
  }
}

export class SaveTextTransientError extends Error {
  constructor(message = 'Save failed transiently') {
    super(message);
    this.name = 'SaveTextTransientError';
  }
}
