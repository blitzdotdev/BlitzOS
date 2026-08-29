import { describe, expect, it } from 'vitest';
import { formatCommandForDisplay } from './command-display';

describe('formatCommandForDisplay', () => {
  it('quotes every POSIX token so command and entry paths are visually distinct', () => {
    expect(
      formatCommandForDisplay(
        '/Applications/Lody.app/Contents/MacOS/Lody',
        [
          '/Applications/Lody.app/Contents/Resources/app.asar.unpacked/resources/cli/index.js',
          'start',
        ],
        'darwin'
      )
    ).toBe(
      "'/Applications/Lody.app/Contents/MacOS/Lody' '/Applications/Lody.app/Contents/Resources/app.asar.unpacked/resources/cli/index.js' 'start'"
    );
  });

  it('escapes POSIX single quotes', () => {
    expect(formatCommandForDisplay('/tmp/it-is', ["/tmp/it's here"], 'linux')).toBe(
      "'/tmp/it-is' '/tmp/it'\\''s here'"
    );
  });

  it('uses Windows-style quoting on win32', () => {
    expect(
      formatCommandForDisplay('C:\\Program Files\\Lody\\lody.exe', ['say "hi"'], 'win32')
    ).toBe('"C:\\Program Files\\Lody\\lody.exe" "say \\"hi\\""');
  });
});
