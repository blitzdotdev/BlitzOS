import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AcpConfigOptionValue } from '@lody/shared';
import {
  areAcpSessionConfigPreferencesEqual,
  buildAcpSessionConfigCandidates,
  EMPTY_ACP_SESSION_USER_CONFIG_EDITS,
  fenceAcpSessionUserEdits,
  resolveAcpSessionConfigSelection,
  type AcpSessionConfigCandidates,
  type AcpSessionConfigPreferences,
  type AcpSessionConfigSelectionInputs,
  type AcpSessionSelectorOptionsInput,
  type AcpSessionUserConfigEdits,
  type ResolvedAcpSessionConfigSelection,
} from '@/lib/acp-session-config-selection';
import type { AcpSelectorTarget } from '@/components/shared/acp-selector-options';

/**
 * ACP run-config selection with NO effects. The only stored state is the
 * user's unsent edits; everything else derives per render
 * (`lib/acp-session-config-selection.ts` has the full story of the reconcile
 * loop this replaces — do not reintroduce a reducer that stores the resolved
 * selection or an effect that pushes inputs into it).
 *
 * Two stages, because the capability catalog itself depends on the selection
 * (Codex reasoning tiers follow the selected model; provisional menus are
 * enriched with an out-of-catalog value):
 *
 * 1. This hook returns UNVALIDATED `candidates` — feed those to
 *    `useSessionAcpSelectorContext`.
 * 2. `useResolvedAcpSessionConfigSelection(selection, selectorOptions)`
 *    validates the same inputs against the catalog those candidates produced.
 *
 * The fencing on (targetKey, preferenceRevision) happens as a render-phase
 * state adjustment: it depends only on those two inputs — never on anything
 * derived from the selection — so it settles in one extra render.
 */

type EditsFence = {
  targetKey: string | null;
  preferenceRevision: string | null;
  edits: AcpSessionUserConfigEdits;
};

export type UseAcpSessionConfigSelectionStateArgs = {
  /** While false the selection derives from empty inputs and no fencing runs. */
  enabled?: boolean;
  targetKey: string | null;
  preferenceRevision: string;
  preferences: AcpSessionConfigPreferences;
  runtimePreferences?: AcpSessionConfigPreferences | null;
  preserveUnsentUserEdits?: boolean;
};

const EMPTY_PREFERENCES: AcpSessionConfigPreferences = {};

export type AcpSessionConfigSelectionHandle = {
  /** Inputs for `useResolvedAcpSessionConfigSelection`; treat as opaque. */
  selection: AcpSessionConfigSelectionInputs;
  /** Unvalidated chain heads for capability lookups. */
  candidates: AcpSessionConfigCandidates;
  /**
   * The (targetKey, preferenceRevision) the current edits are fenced for.
   * Multi-step flows (a recent-run-config entry switching the agent before
   * writing its model) wait for these to catch up with what they set.
   */
  appliedTargetKey: string | null;
  appliedPreferenceRevision: string | null;
  /** Whether the current run config contains an unsent user edit. */
  hasUserEdits: boolean;
  selectMode: (value: string | null) => void;
  selectModel: (value: string | null) => void;
  selectConfigOption: (configId: string, value: AcpConfigOptionValue) => void;
  replaceConfigOptions: (values: Record<string, AcpConfigOptionValue>) => void;
};

// Blitz seam 29: see vendor/lody/BLITZ-PATCHES.md.
const retainedUnsentUserEdits = new Map<string, AcpSessionUserConfigEdits>();

function retainUnsentUserEdits(targetKey: string | null, edits: AcpSessionUserConfigEdits): void {
  if (targetKey === null) return;
  retainedUnsentUserEdits.delete(targetKey);
  if (!edits.mode && !edits.model && Object.keys(edits.configOptions).length === 0) return;
  retainedUnsentUserEdits.set(targetKey, edits);
  if (retainedUnsentUserEdits.size <= 8) return;
  for (const oldestTargetKey of retainedUnsentUserEdits.keys()) {
    retainedUnsentUserEdits.delete(oldestTargetKey);
    break;
  }
}

export function useAcpSessionConfigSelectionState({
  enabled = true,
  targetKey,
  preferenceRevision,
  preferences,
  runtimePreferences,
  preserveUnsentUserEdits = false,
}: UseAcpSessionConfigSelectionStateArgs): AcpSessionConfigSelectionHandle {
  const [fence, setFence] = useState<EditsFence>({
    targetKey: null,
    preferenceRevision: null,
    edits: EMPTY_ACP_SESSION_USER_CONFIG_EDITS,
  });

  if (
    enabled &&
    (fence.targetKey !== targetKey || fence.preferenceRevision !== preferenceRevision)
  ) {
    const targetChanged = fence.targetKey !== targetKey;
    if (targetChanged && preserveUnsentUserEdits) {
      retainUnsentUserEdits(fence.targetKey, fence.edits);
    }
    const seededEdits =
      targetChanged && preserveUnsentUserEdits
        ? targetKey === null
          ? EMPTY_ACP_SESSION_USER_CONFIG_EDITS
          : (retainedUnsentUserEdits.get(targetKey) ?? EMPTY_ACP_SESSION_USER_CONFIG_EDITS)
        : fence.edits;
    setFence({
      targetKey,
      preferenceRevision,
      edits: fenceAcpSessionUserEdits(seededEdits, {
        targetChanged: targetChanged && !preserveUnsentUserEdits,
        preserveUnsentUserEdits,
        preferences,
      }),
    });
  }

  const latestFenceRef = useRef({ fence, preserveUnsentUserEdits });
  latestFenceRef.current = { fence, preserveUnsentUserEdits };
  useEffect(() => () => {
    const latest = latestFenceRef.current;
    if (latest.preserveUnsentUserEdits) {
      retainUnsentUserEdits(latest.fence.targetKey, latest.fence.edits);
    }
    // This cleanup only writes the module cache, so it cannot oscillate React state.
  }, []);

  /* VALUE-stabilize the preference inputs. `preferences`/`runtimePreferences`
     are object literals resolved from `sessionDoc.history`, and the doc mirror
     rebuilds `history` with unchanged values on every merge frame while an
     agent streams. The reducer this hook replaced absorbed that churn by
     returning the same state object; without this cache the frame-fresh
     identities would miss every downstream memo — selector catalog rebuild and
     a composer-subtree re-render per document frame on the conversation hot
     path. Ref writes during render are safe here: a replaced value is always
     value-equal to what it replaces. */
  const stablePreferencesRef = useRef(preferences);
  if (!areAcpSessionConfigPreferencesEqual(stablePreferencesRef.current, preferences)) {
    stablePreferencesRef.current = preferences;
  }
  const stableRuntimePreferencesRef = useRef(runtimePreferences ?? null);
  if (
    !areAcpSessionConfigPreferencesEqual(
      stableRuntimePreferencesRef.current,
      runtimePreferences ?? null
    )
  ) {
    stableRuntimePreferencesRef.current = runtimePreferences ?? null;
  }

  const effectivePreferences = enabled ? stablePreferencesRef.current : EMPTY_PREFERENCES;
  const effectiveRuntimePreferences = enabled ? stableRuntimePreferencesRef.current : null;
  const edits = enabled ? fence.edits : EMPTY_ACP_SESSION_USER_CONFIG_EDITS;

  const selection = useMemo<AcpSessionConfigSelectionInputs>(
    () => ({
      edits,
      preferences: effectivePreferences,
      runtimePreferences: effectiveRuntimePreferences,
    }),
    [edits, effectivePreferences, effectiveRuntimePreferences]
  );
  const candidates = useMemo(() => buildAcpSessionConfigCandidates(selection), [selection]);

  const selectMode = useCallback((value: string | null) => {
    setFence((prev) => ({ ...prev, edits: { ...prev.edits, mode: { value } } }));
  }, []);
  const selectModel = useCallback((value: string | null) => {
    setFence((prev) => ({ ...prev, edits: { ...prev.edits, model: { value } } }));
  }, []);
  const selectConfigOption = useCallback((configId: string, value: AcpConfigOptionValue) => {
    setFence((prev) => ({
      ...prev,
      edits: {
        ...prev.edits,
        configOptions: { ...prev.edits.configOptions, [configId]: value },
      },
    }));
  }, []);
  const replaceConfigOptions = useCallback((values: Record<string, AcpConfigOptionValue>) => {
    setFence((prev) => ({
      ...prev,
      edits: { ...prev.edits, configOptions: { ...values } },
    }));
  }, []);

  return {
    selection,
    candidates,
    appliedTargetKey: fence.targetKey,
    appliedPreferenceRevision: fence.preferenceRevision,
    hasUserEdits:
      edits.mode !== undefined ||
      edits.model !== undefined ||
      Object.keys(edits.configOptions).length > 0,
    selectMode,
    selectModel,
    selectConfigOption,
    replaceConfigOptions,
  };
}

export function useResolvedAcpSessionConfigSelection(
  selection: AcpSessionConfigSelectionInputs,
  selectorOptions: AcpSessionSelectorOptionsInput,
  /**
   * Agent identity for model-dependent selector normalization (Codex reasoning
   * tiers follow the RESOLVED model, not the unvalidated candidate).
   */
  target?: Pick<AcpSelectorTarget, 'cliType' | 'agentType'>
): ResolvedAcpSessionConfigSelection {
  const cliType = target?.cliType ?? null;
  const agentType = target?.agentType ?? null;
  return useMemo(
    () => resolveAcpSessionConfigSelection(selection, selectorOptions, { cliType, agentType }),
    [agentType, cliType, selection, selectorOptions]
  );
}
