import { Fragment, useEffect, useId, useRef, useState } from 'react';

export type CockpitSelectOption = {
  value: string;
  label: string;
  description?: string;
  group?: string;
};

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
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listboxId = useId();
  const selected = options.find((option) => option.value === value);

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
        <div className="webapp-select-menu" id={listboxId} role="listbox" aria-label={ariaLabel}>
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
