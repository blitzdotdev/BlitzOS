import type { ReactNode } from 'react';

/** The one settings panel header (settings-design-kit): eyebrow, title and
 * detail on the left, at most one action on the right. Six panels used to
 * hand-roll this markup; they all render this instead now. */
export function PanelHeader({
  eyebrow,
  title,
  detail,
  action,
}: {
  eyebrow: string;
  title: string;
  detail: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header className="settings-panel-header">
      <div>
        <p>{eyebrow}</p>
        <h1>{title}</h1>
        <span>{detail}</span>
      </div>
      {action}
    </header>
  );
}

/** Two states get a switch, and a switch saves itself (settings-design-kit):
 * the change handler writes immediately, `disabled` covers the in-flight
 * write, and there is never a Save button next to one. */
export function SettingsSwitch({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="settings-switch-row">
      <span className="settings-switch-copy">
        <strong>{label}</strong>
        {description !== undefined && <span>{description}</span>}
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span className="settings-switch-track" aria-hidden="true" />
    </label>
  );
}
