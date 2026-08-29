export type ProjectSharingUpdate = {
  desired: boolean;
  requestId: number;
  status: 'saving' | 'awaiting-sync';
};

export type ProjectSharingState = Record<string, ProjectSharingUpdate>;

export type ProjectSharingAction =
  | {
      type: 'begin';
      key: string;
      desired: boolean;
      requestId: number;
    }
  | {
      type: 'succeeded';
      key: string;
      requestId: number;
      observedSharedWithTeam: boolean | undefined;
    }
  | {
      type: 'failed';
      key: string;
      requestId: number;
    }
  | {
      type: 'reconcile';
      sharedWithTeamByKey: ReadonlyMap<string, boolean>;
    };

function removeUpdate(state: ProjectSharingState, key: string): ProjectSharingState {
  const { [key]: _, ...rest } = state;
  return rest;
}

/**
 * Keeps an acknowledged mutation visible until the reactive Convex query catches up.
 * A request failure only removes the matching request, so a stale completion cannot
 * overwrite a newer toggle for the same project.
 */
export function projectSharingReducer(
  state: ProjectSharingState,
  action: ProjectSharingAction
): ProjectSharingState {
  switch (action.type) {
    case 'begin':
      return {
        ...state,
        [action.key]: {
          desired: action.desired,
          requestId: action.requestId,
          status: 'saving',
        },
      };
    case 'succeeded': {
      const update = state[action.key];
      if (!update || update.requestId !== action.requestId) return state;
      if (action.observedSharedWithTeam === update.desired) {
        return removeUpdate(state, action.key);
      }
      return {
        ...state,
        [action.key]: { ...update, status: 'awaiting-sync' },
      };
    }
    case 'failed': {
      const update = state[action.key];
      if (!update || update.requestId !== action.requestId) return state;
      return removeUpdate(state, action.key);
    }
    case 'reconcile': {
      let next = state;
      for (const [key, update] of Object.entries(state)) {
        if (
          update.status === 'awaiting-sync' &&
          action.sharedWithTeamByKey.get(key) === update.desired
        ) {
          if (next === state) next = { ...state };
          delete next[key];
        }
      }
      return next;
    }
  }

  return state;
}
