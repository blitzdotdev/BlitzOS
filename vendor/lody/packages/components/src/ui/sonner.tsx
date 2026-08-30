import { Toaster as Sonner, ToasterProps } from 'sonner';
import { useResolvedTheme } from '@/theme-provider';

const TOASTER_OFFSET = {
  top: 'calc(24px + env(safe-area-inset-top, 0px))',
} satisfies ToasterProps['offset'];

const MOBILE_TOASTER_OFFSET = {
  top: 'calc(16px + env(safe-area-inset-top, 0px))',
} satisfies ToasterProps['mobileOffset'];

/**
 * `basis-full` is what forces a toast button onto its own row (see the `toast`
 * class below). `-mr-5` gives back the close button's `pr-9` lane so the button
 * sits symmetrically inside the toast padding.
 */
const TOAST_BUTTON_CLASS_NAME =
  'mt-2.5! ml-0! -mr-5! h-7! basis-full! justify-center! rounded-md!';

const Toaster = ({
  closeButton = true,
  position = 'top-center',
  offset = TOASTER_OFFSET,
  mobileOffset = MOBILE_TOASTER_OFFSET,
  style,
  toastOptions,
  ...props
}: ToasterProps) => {
  // The app resolves light/dark itself (`ThemeProvider`), so Sonner must be told
  // the RESOLVED theme rather than being left to re-derive it from the OS. Its
  // own `system` handling reads `prefers-color-scheme`, which disagrees with the
  // app whenever the user picked a theme explicitly — and Sonner hard-codes the
  // description color per theme attribute, so a mismatch rendered near-white
  // description text on the light toast surface.
  const resolvedTheme = useResolvedTheme();

  return (
    <Sonner
      theme={resolvedTheme}
      className="toaster group"
      closeButton={closeButton}
      position={position}
      offset={offset}
      mobileOffset={mobileOffset}
      toastOptions={{
        ...toastOptions,
        classNames: {
          // Leave room on the right for the inline close button so long
          // messages don't slip underneath it. Sonner lays the toast out as one
          // centered row (icon | text | action); `items-start` + `flex-wrap`
          // turns it into "icon + text on the first line, action on its own row"
          // so a wrapping description is never squeezed into a narrow column
          // beside the button.
          toast: 'pr-9! items-start! flex-wrap!',
          // `flex-1 basis-0` (not the default `basis-auto`) keeps the text
          // column on the first line next to the icon; with `basis-auto` a long
          // description wraps the whole column below the icon.
          content: 'min-w-0! flex-1! basis-0!',
          icon: 'mt-0.5!',
          // Sonner hard-codes description colors per theme; use the app token so
          // it always reads against the toast surface.
          description: 'text-muted-foreground!',
          actionButton: TOAST_BUTTON_CLASS_NAME,
          cancelButton: TOAST_BUTTON_CLASS_NAME,
          // Sonner ships a circular close button floating on the top-left
          // corner. Restyle it into a plain, muted "×" tucked inside on the
          // right edge, aligned with the title line (matches the neutral design).
          closeButton:
            'left-auto! right-2! top-4! size-5! rounded-md! border-transparent! bg-transparent! text-muted-foreground! transition-colors! hover:bg-muted! hover:text-foreground!',
          ...toastOptions?.classNames,
        },
      }}
      style={
        {
          // `--z-toast` is declared in the editor-overlay z-index registry but never
          // injected as a CSS variable, so it resolves to `auto` and toasts can render
          // behind positioned UI (e.g. the session header at top-center). Fall back to
          // the registry's toast layer (100) so toasts always sit on top.
          zIndex: 'var(--z-toast, 100)',
          // These tokens are raw HSL triplets (e.g. `214 32% 91%`), so they must
          // be wrapped in `hsl(...)` to be valid colors — Sonner drops them into
          // bare `background`/`color`/`border` declarations. The background is an
          // elevated `color-mix` (same recipe as the app's dropdown surfaces in
          // `menu-styles.ts`) so the toast stays distinct from the page even in
          // themes where `--popover` equals `--background` (e.g. light mode).
          '--normal-bg':
            'color-mix(in oklab, hsl(var(--popover)) 92%, hsl(var(--foreground)) 8%)',
          '--normal-text': 'hsl(var(--popover-foreground))',
          '--normal-border': 'hsl(var(--border))',
          // Cancel Sonner's default corner-float transform so the close button
          // sits inline; its position comes from the `closeButton` classNames
          // (`right-2` + `top-4`, which lands it on the title line).
          '--toast-close-button-transform': 'none',
          ...style,
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
