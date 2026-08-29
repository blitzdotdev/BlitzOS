export type LocalLoroDataPlaneTurnScheduler = (work: () => void) => () => void;

/** Process-wide bulk-work pacer shared by every workspace engine. */
export type LocalLoroDataPlaneScheduler = {
  scheduleDataWork: (work: () => void | Promise<void>) => () => void;
};

const scheduleDataWorkNextTurn: LocalLoroDataPlaneTurnScheduler = (work) => {
  const handle = setTimeout(work, 0);
  return () => clearTimeout(handle);
};

/**
 * Builds a cooperative scheduler: bulk callbacks run one at a time in separate
 * event-loop turns, so no workspace's bulk export can monopolize the process.
 */
export const createLocalLoroDataPlaneScheduler = (
  scheduleTurn: LocalLoroDataPlaneTurnScheduler = scheduleDataWorkNextTurn
): LocalLoroDataPlaneScheduler => {
  type DataWork = { run: () => void | Promise<void>; cancelled: boolean };
  const queue: DataWork[] = [];
  let running = false;
  let cancelScheduledTurn: (() => void) | null = null;

  const takeNext = (): DataWork | null => {
    for (;;) {
      const work = queue.shift();
      if (!work) return null;
      if (!work.cancelled) return work;
    }
  };

  const requestRun = (): void => {
    if (running || cancelScheduledTurn || queue.length === 0) return;
    cancelScheduledTurn = scheduleTurn(() => {
      cancelScheduledTurn = null;
      const work = takeNext();
      if (!work) {
        return;
      }
      running = true;
      void Promise.resolve()
        .then(work.run)
        .finally(() => {
          running = false;
          requestRun();
        });
    });
  };

  return {
    scheduleDataWork: (run) => {
      const work: DataWork = { run, cancelled: false };
      queue.push(work);
      requestRun();
      return () => {
        work.cancelled = true;
      };
    },
  };
};
