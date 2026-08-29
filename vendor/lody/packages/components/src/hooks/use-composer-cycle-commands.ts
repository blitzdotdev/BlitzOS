import { useTranslation } from 'react-i18next';
import { getCommandKeybindings, useCommand } from '@/lib/commands';

/** One cyclable composer option: an ordered value list, the current value, and a setter. */
export type ComposerCycleTarget = {
  values: string[];
  current: string | null;
  onSelect: (value: string) => void;
};

function cycleNext(target: ComposerCycleTarget | null | undefined): void {
  if (!target || target.values.length === 0) return;
  const index = target.current ? target.values.indexOf(target.current) : -1;
  const next = target.values[(index + 1) % target.values.length];
  if (next != null && next !== target.current) target.onSelect(next);
}

function canCycle(target: ComposerCycleTarget | null | undefined): boolean {
  return Boolean(target && target.values.length > 1);
}

/**
 * Registers the composer "cycle X" commands, shared by the chat landing and the in-session
 * composer (the registry's per-id stack lets whichever is mounted win). Mode cycling is
 * bound to ⇧Tab with a binding-level composer-focus guard, so custom bindings and command
 * palette execution remain available outside the input without hijacking reverse-Tab in the
 * palette / dialogs / settings. Provider / model / think-effort cyclers ship without a default
 * binding and are rebindable from the keyboard settings page.
 *
 * Pass `null` for any target that isn't applicable in the current surface (e.g. the agent
 * provider can't change mid-conversation).
 */
export function useComposerCycleCommands(params: {
  enabled?: boolean;
  mode?: ComposerCycleTarget | null;
  provider?: ComposerCycleTarget | null;
  model?: ComposerCycleTarget | null;
  thinkEffort?: ComposerCycleTarget | null;
}): void {
  const { t } = useTranslation();
  const { enabled = true, mode, provider, model, thinkEffort } = params;

  useCommand(
    {
      id: 'session.cycleMode',
      title: t('commands.session.cycleMode', 'Cycle Agent Mode'),
      category: 'Session',
      keybindings: getCommandKeybindings('session.cycleMode'),
      when: () => canCycle(mode),
      run: () => cycleNext(mode),
    },
    enabled
  );

  useCommand(
    {
      id: 'session.cycleProvider',
      title: t('commands.session.cycleProvider', 'Cycle ACP Provider'),
      category: 'Session',
      keybindings: getCommandKeybindings('session.cycleProvider'),
      when: () => canCycle(provider),
      run: () => cycleNext(provider),
    },
    enabled
  );

  useCommand(
    {
      id: 'session.cycleModel',
      title: t('commands.session.cycleModel', 'Cycle Model'),
      category: 'Session',
      keybindings: getCommandKeybindings('session.cycleModel'),
      when: () => canCycle(model),
      run: () => cycleNext(model),
    },
    enabled
  );

  useCommand(
    {
      id: 'session.cycleThinkEffort',
      title: t('commands.session.cycleThinkEffort', 'Cycle Thinking Effort'),
      category: 'Session',
      keybindings: getCommandKeybindings('session.cycleThinkEffort'),
      when: () => canCycle(thinkEffort),
      run: () => cycleNext(thinkEffort),
    },
    enabled
  );
}
