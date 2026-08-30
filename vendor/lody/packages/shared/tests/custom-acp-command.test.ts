import { describe, expect, it } from 'vitest';

import {
  formatCustomAcpCommandLine,
  isCustomAcpLaunchSpec,
  parseCustomAcpCommandLine,
  serializeCustomAcpLaunchSpec,
} from '../src';

describe('parseCustomAcpCommandLine', () => {
  it('splits a plain command line on whitespace', () => {
    expect(parseCustomAcpCommandLine('npx -y my-acp-agent --flag')).toEqual({
      command: 'npx',
      args: ['-y', 'my-acp-agent', '--flag'],
    });
  });

  it('omits args for a bare command', () => {
    expect(parseCustomAcpCommandLine('my-acp')).toEqual({ command: 'my-acp' });
  });

  it('collapses repeated whitespace and trims the line', () => {
    expect(parseCustomAcpCommandLine('  my-acp   --acp \t--x  ')).toEqual({
      command: 'my-acp',
      args: ['--acp', '--x'],
    });
  });

  it('keeps double-quoted segments together and supports escapes inside them', () => {
    expect(parseCustomAcpCommandLine('"/opt/my tools/agent" --name "a \\"b\\" c"')).toEqual({
      command: '/opt/my tools/agent',
      args: ['--name', 'a "b" c'],
    });
  });

  it('keeps single-quoted segments together without escape handling', () => {
    expect(parseCustomAcpCommandLine("agent --config '/home/u/my config.toml'")).toEqual({
      command: 'agent',
      args: ['--config', '/home/u/my config.toml'],
    });
  });

  it('inside double quotes only escapes " and \\, keeping other backslashes literal (POSIX)', () => {
    // `"a\nb"` is a literal backslash-n, not a newline; only \" and \\ escape.
    expect(parseCustomAcpCommandLine('agent "a\\nb"')).toEqual({
      command: 'agent',
      args: ['a\\nb'],
    });
    expect(parseCustomAcpCommandLine('agent "a\\\\b"')).toEqual({
      command: 'agent',
      args: ['a\\b'],
    });
    expect(parseCustomAcpCommandLine('agent "a\\"b"')).toEqual({
      command: 'agent',
      args: ['a"b'],
    });
  });

  it('treats a backslash outside quotes as an escape', () => {
    expect(parseCustomAcpCommandLine('agent --path /tmp/with\\ space')).toEqual({
      command: 'agent',
      args: ['--path', '/tmp/with space'],
    });
  });

  it('preserves empty quoted tokens', () => {
    expect(parseCustomAcpCommandLine('agent ""')).toEqual({ command: 'agent', args: [''] });
  });

  it('returns null for empty input or unclosed quoting', () => {
    expect(parseCustomAcpCommandLine('')).toBeNull();
    expect(parseCustomAcpCommandLine('   ')).toBeNull();
    expect(parseCustomAcpCommandLine('agent "unclosed')).toBeNull();
    expect(parseCustomAcpCommandLine("agent 'unclosed")).toBeNull();
    expect(parseCustomAcpCommandLine('agent trailing\\')).toBeNull();
  });
});

describe('formatCustomAcpCommandLine', () => {
  it('round-trips through parseCustomAcpCommandLine', () => {
    const specs = [
      { command: 'npx', args: ['-y', 'my-acp-agent', '--flag'] },
      { command: '/opt/my tools/agent', args: ['--name', 'a "b" c', ''] },
      { command: 'plain' },
      { command: 'back\\slash', args: ["single'quote"] },
    ];
    for (const spec of specs) {
      const line = formatCustomAcpCommandLine(spec);
      expect(parseCustomAcpCommandLine(line)).toEqual(
        spec.args && spec.args.length > 0 ? spec : { command: spec.command }
      );
    }
  });

  it('leaves simple tokens unquoted', () => {
    expect(formatCustomAcpCommandLine({ command: 'npx', args: ['-y', 'pkg'] })).toBe('npx -y pkg');
  });
});

describe('isCustomAcpLaunchSpec', () => {
  it('accepts valid specs', () => {
    expect(isCustomAcpLaunchSpec({ command: 'a' })).toBe(true);
    expect(isCustomAcpLaunchSpec({ command: 'a', args: [] })).toBe(true);
    expect(isCustomAcpLaunchSpec({ command: 'a', args: ['b'] })).toBe(true);
  });

  it('rejects invalid shapes', () => {
    expect(isCustomAcpLaunchSpec(undefined)).toBe(false);
    expect(isCustomAcpLaunchSpec(null)).toBe(false);
    expect(isCustomAcpLaunchSpec('a')).toBe(false);
    expect(isCustomAcpLaunchSpec({})).toBe(false);
    expect(isCustomAcpLaunchSpec({ command: '' })).toBe(false);
    expect(isCustomAcpLaunchSpec({ command: '  ' })).toBe(false);
    expect(isCustomAcpLaunchSpec({ command: 'a', args: 'b' })).toBe(false);
    expect(isCustomAcpLaunchSpec({ command: 'a', args: [1] })).toBe(false);
  });
});

describe('serializeCustomAcpLaunchSpec', () => {
  it('produces distinct keys for distinct argv', () => {
    const a = serializeCustomAcpLaunchSpec({ command: 'x', args: ['a', 'b'] });
    const b = serializeCustomAcpLaunchSpec({ command: 'x', args: ['a b'] });
    const c = serializeCustomAcpLaunchSpec({ command: 'x a', args: ['b'] });
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('treats missing args and empty args the same', () => {
    expect(serializeCustomAcpLaunchSpec({ command: 'x' })).toBe(
      serializeCustomAcpLaunchSpec({ command: 'x', args: [] })
    );
  });
});
