import { Check } from 'lucide-react';
import { motion } from 'framer-motion';
import type { LodyResolvedVSCodeTheme } from '@/lib/vscode-theme';
import { cn } from '@/lib/utils';

/**
 * Mock-editor swatch preview for a single VSCode theme. Renders a
 * tile with a small mocked code-lines preview painted in the
 * theme's actual bg / fg / accent / muted colors, the theme's name
 * below, and a check badge when selected.
 *
 * Shared by the desktop onboarding theme screen and the mobile
 * general-settings code-theme picker — keeping the swatch logic
 * in one place avoids the "swatch colors look different across
 * surfaces" drift when picking which key to read from
 * `theme.colors` (the same key set is right in both places).
 */
export function ThemeTile({
  theme,
  selected,
  onSelect,
}: {
  theme: LodyResolvedVSCodeTheme;
  selected: boolean;
  onSelect: () => void;
}) {
  const colors = theme.colors as Record<string, string>;
  const bg = colors['editor.background'] ?? colors['sideBar.background'] ?? '#1e1e1e';
  const fg = colors['editor.foreground'] ?? colors['foreground'] ?? '#cccccc';
  const accent =
    colors['focusBorder'] ??
    colors['statusBar.background'] ??
    colors['button.background'] ??
    '#3794ff';
  const muted =
    colors['editorLineNumber.foreground'] ??
    colors['descriptionForeground'] ??
    'rgba(127,127,127,0.6)';

  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.98 }}
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'group relative flex flex-col gap-2 overflow-hidden rounded-xl border p-2 text-left transition-colors',
        'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring',
        selected
          ? 'border-primary/60 shadow-[0_0_0_3px_hsl(var(--primary)/0.1)]'
          : 'border-border/60 hover:border-border'
      )}
    >
      <div
        className="relative h-16 w-full overflow-hidden rounded-lg border border-border/30"
        style={{ background: bg }}
      >
        {/* Mock editor lines */}
        <div className="absolute inset-2 flex flex-col gap-1.5">
          <div className="flex items-center gap-1">
            <span className="block h-1.5 w-2 rounded-full" style={{ background: muted }} />
            <span className="block h-1.5 w-10 rounded-full" style={{ background: accent }} />
          </div>
          <div className="flex items-center gap-1 pl-3">
            <span className="block h-1.5 w-3 rounded-full" style={{ background: muted }} />
            <span
              className="block h-1.5 w-8 rounded-full"
              style={{ background: fg, opacity: 0.7 }}
            />
            <span
              className="block h-1.5 w-5 rounded-full"
              style={{ background: accent, opacity: 0.7 }}
            />
          </div>
          <div className="flex items-center gap-1 pl-3">
            <span className="block h-1.5 w-3 rounded-full" style={{ background: muted }} />
            <span
              className="block h-1.5 w-12 rounded-full"
              style={{ background: fg, opacity: 0.5 }}
            />
          </div>
        </div>
        {selected ? (
          <span className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm">
            <Check className="h-3 w-3" />
          </span>
        ) : null}
      </div>
      <div className="truncate text-xs font-medium text-foreground" title={theme.label}>
        {theme.label}
      </div>
    </motion.button>
  );
}
