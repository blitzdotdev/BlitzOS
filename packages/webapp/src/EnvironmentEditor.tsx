import type { WorkspaceEnvironment } from '@blitzos/schema';
import { useRef, useState } from 'react';

interface EnvironmentRow {
  id: number;
  name: string;
  value: string;
}

export const EMPTY_WORKSPACE_ENVIRONMENT: WorkspaceEnvironment = {
  env: {},
  startupScript: null,
};

export function populatedEnvironment(
  environment: WorkspaceEnvironment,
): WorkspaceEnvironment | undefined {
  return Object.keys(environment.env).length > 0 || environment.startupScript !== null
    ? environment
    : undefined;
}

export function EnvironmentEditor({
  initial,
  onChange,
}: {
  initial: WorkspaceEnvironment;
  onChange: (environment: WorkspaceEnvironment) => void;
}) {
  const initialRows = Object.entries(initial.env).map(([name, value], id) => ({
    id,
    name,
    value,
  }));
  const [rows, setRows] = useState<EnvironmentRow[]>(initialRows.length > 0
    ? initialRows
    : [{ id: 0, name: '', value: '' }]);
  const [startupScript, setStartupScript] = useState(initial.startupScript ?? '');
  const nextId = useRef(rows.length);

  const publish = (nextRows: EnvironmentRow[], script: string) => {
    onChange({
      env: Object.fromEntries(nextRows
        .filter(({ name }) => name !== '')
        .map(({ name, value }) => [name, value])),
      startupScript: script === '' ? null : script,
    });
  };

  const updateRow = (id: number, field: 'name' | 'value', value: string) => {
    const next = rows.map((row) => row.id === id ? { ...row, [field]: value } : row);
    setRows(next);
    publish(next, startupScript);
  };

  const removeRow = (id: number) => {
    const next = rows.filter((row) => row.id !== id);
    const retained = next.length > 0 ? next : [{ id: nextId.current++, name: '', value: '' }];
    setRows(retained);
    publish(retained, startupScript);
  };

  // The Advanced <details> shell lives in the create screens, so this editor
  // and AgentRulesPicker sit inside one collapsed section rather than two.
  return (
    <>
      <div className="blueprint-selection__heading">
        <h2>Environment variables</h2>
        <p>Config only — not for secrets. Use integrations for secrets.</p>
      </div>
      <div className="blueprint-environment-rows">
        {rows.map((row, index) => (
          <div className="blueprint-environment-row" key={row.id}>
            <input
              aria-label={`Environment variable key ${index + 1}`}
              placeholder="KEY"
              value={row.name}
              maxLength={128}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(event) => updateRow(row.id, 'name', event.currentTarget.value)}
            />
            <input
              aria-label={`Environment variable value ${index + 1}`}
              placeholder="Value"
              value={row.value}
              maxLength={8192}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(event) => updateRow(row.id, 'value', event.currentTarget.value)}
            />
            <button
              type="button"
              aria-label={`Remove environment variable ${index + 1}`}
              onClick={() => removeRow(row.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <button
        className="blueprint-environment-add"
        type="button"
        onClick={() => {
          const next = [...rows, { id: nextId.current++, name: '', value: '' }];
          setRows(next);
        }}
      >
        + Add variable
      </button>
      <label className="blueprint-field blueprint-startup-script">
        Startup script
        <textarea
          aria-label="Startup script"
          value={startupScript}
          maxLength={65536}
          placeholder="#!/usr/bin/env bash"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => {
            const script = event.currentTarget.value;
            setStartupScript(script);
            publish(rows, script);
          }}
        />
      </label>
    </>
  );
}
