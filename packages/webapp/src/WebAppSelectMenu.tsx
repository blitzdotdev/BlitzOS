import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

export type CockpitSelectOption = {
  value: string;
  label: string;
  description?: string;
  group?: string;
  /** Shown but not selectable. A machine type outside the volume's location
   * is the case this exists for: hiding it would leave the reader guessing
   * why their type is missing. */
  disabled?: boolean;
};

/** The gap between the trigger and the popover, and the margin the popover
 * keeps from the viewport edge. */
const MENU_GAP = 6;
const VIEWPORT_MARGIN = 8;
/** `min-width` in webapp-select.css, so the clamp cannot push the popover
 * past the right edge, and the shortest popover worth drawing. */
const MENU_MIN_WIDTH = 220;
const MENU_MIN_HEIGHT = 120;
const MENU_MAX_HEIGHT = 320;

/** Where the popover sits, in viewport coordinates.
 *
 * It is `position: fixed`, so no scroll container between it and the page can
 * clip it and nothing between it and the page can paint over it. That is what
 * a popover inside the workspace-details dialog needs: its body scrolls, and
 * an absolutely positioned menu was cut off by it. */
type MenuPlacement = {
  left: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
};

function placeMenu(trigger: HTMLElement): MenuPlacement {
  const rect = trigger.getBoundingClientRect();
  const left = Math.max(
    VIEWPORT_MARGIN,
    Math.min(rect.left, window.innerWidth - MENU_MIN_WIDTH - VIEWPORT_MARGIN),
  );
  const above = rect.top - MENU_GAP - VIEWPORT_MARGIN;
  const below = window.innerHeight - rect.bottom - MENU_GAP - VIEWPORT_MARGIN;
  // Upward is the shape every caller has drawn since this control existed;
  // it flips only where there is more room the other way.
  if (above >= below) {
    return {
      left,
      bottom: window.innerHeight - rect.top + MENU_GAP,
      maxHeight: Math.max(MENU_MIN_HEIGHT, Math.min(MENU_MAX_HEIGHT, above)),
    };
  }
  return {
    left,
    top: rect.bottom + MENU_GAP,
    maxHeight: Math.max(MENU_MIN_HEIGHT, Math.min(MENU_MAX_HEIGHT, below)),
  };
}

type WebAppSelectMenuProps = {
  ariaLabel: string;
  value: string;
  options: CockpitSelectOption[];
  onChange: (value: string) => void;
  prefix?: string;
  className?: string;
  disabled?: boolean;
};

export function WebAppSelectMenu({
  ariaLabel,
  value,
  options,
  onChange,
  prefix,
  className = '',
  disabled = false,
}: WebAppSelectMenuProps) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<MenuPlacement | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listboxId = useId();
  const selected = options.find((option) => option.value === value);

  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    const place = () => {
      const trigger = buttonRef.current;
      if (trigger !== null) setPlacement(placeMenu(trigger));
    };
    place();
    // Capture, so the popover follows a scroll in any container above it
    // rather than staying where the trigger used to be.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      // SAFETY: Browser pointer-event targets used for DOM containment are Nodes.
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    window.addEventListener('pointerdown', closeOutside);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('pointerdown', closeOutside);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  return (
    <div className={`webapp-select${className ? ` ${className}` : ''}`} ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="webapp-select-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-controls={listboxId}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        {prefix && <span className="webapp-select-prefix">{prefix}</span>}
        <span className="webapp-select-value">{selected?.label ?? value}</span>
        <span className="webapp-select-chevron" aria-hidden="true">⌃</span>
      </button>
      {open && (
        <div
          className="webapp-select-menu"
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel}
          style={placement === null ? undefined : {
            left: placement.left,
            top: placement.top,
            bottom: placement.bottom,
            maxHeight: placement.maxHeight,
          }}
        >
          {options.map((option, index) => {
            const showGroup = option.group && option.group !== options[index - 1]?.group;
            return (
              <Fragment key={`${option.group ?? 'option'}:${option.value}`}>
                {showGroup && <div className="webapp-select-group">{option.group}</div>}
                <button
                  type="button"
                  className="webapp-select-option"
                  role="option"
                  aria-selected={option.value === value}
                  aria-disabled={option.disabled}
                  disabled={option.disabled}
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                    buttonRef.current?.focus();
                  }}
                >
                  <span className="webapp-select-option-copy">
                    <strong>{option.label}</strong>
                    {option.description && <small>{option.description}</small>}
                  </span>
                  {option.value === value && <span className="webapp-select-check" aria-hidden="true">✓</span>}
                </button>
              </Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}
