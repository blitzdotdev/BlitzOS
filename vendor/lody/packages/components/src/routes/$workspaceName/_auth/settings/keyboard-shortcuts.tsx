import { createFileRoute } from '@tanstack/react-router';
import { KeyboardShortcutsSetting } from '@/components/settings/keyboard-shortcuts-setting';

export const Route = createFileRoute('/$workspaceName/_auth/settings/keyboard-shortcuts')({
  component: KeyboardShortcutsSetting,
});
