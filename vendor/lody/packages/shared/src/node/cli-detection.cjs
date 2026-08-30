const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const CLI_VERSION_COMMAND_TIMEOUT_MS = 5000;

function uniqNonEmpty(values) {
  return Array.from(new Set(values.filter((v) => !!v && String(v).trim() !== '')));
}

function buildAugmentedPath(additionalPaths, basePath) {
  return [...additionalPaths, basePath || ''].join(path.delimiter);
}

function getWindowsGlobalBinPaths() {
  // Common global shim locations for npm/pnpm/yarn on Windows.
  const appData = process.env.APPDATA;
  const localAppData = process.env.LOCALAPPDATA;
  return uniqNonEmpty([
    appData ? path.join(appData, 'npm') : undefined,
    appData ? path.join(appData, 'pnpm') : undefined,
    localAppData ? path.join(localAppData, 'Yarn', 'bin') : undefined,
    localAppData ? path.join(localAppData, 'Microsoft', 'WindowsApps') : undefined,
  ]);
}

function parseRawVersion(output) {
  return output.trim();
}

function selectWindowsWhereCandidate(paths) {
  const normalized = paths.map((p) => p.trim()).filter(Boolean);
  if (normalized.length === 0) return null;

  const preferExt = ['.exe', '.cmd', '.bat', '.com'];
  const lower = normalized.map((p) => p.toLowerCase());
  for (const ext of preferExt) {
    const idx = lower.findIndex((p) => p.endsWith(ext));
    if (idx >= 0) return normalized[idx] || null;
  }

  // Fall back to the first entry (even if it's a .ps1) to preserve legacy behavior.
  return normalized[0] || null;
}

function quoteCmdArg(arg) {
  // Minimal quoting for cmd.exe /c; good enough for our fixed version args and full paths.
  if (arg === '') return '""';
  if (!/[\s"]/u.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

async function runCommand(command, args, env) {
  try {
    const result = await execFileAsync(command, args, {
      env,
      encoding: 'utf-8',
      timeout: CLI_VERSION_COMMAND_TIMEOUT_MS,
      windowsHide: true,
    });
    return {
      stdout: String(result.stdout || ''),
      status: 0,
    };
  } catch (error) {
    return {
      stdout: String(error?.stdout || ''),
      status: typeof error?.code === 'number' ? error.code : null,
      ...(error instanceof Error ? { error } : {}),
    };
  }
}

async function runWindowsCommandResolved(binName, args, env) {
  // Prefer the non-PowerShell shim (.cmd/.exe) even when PowerShell execution policy blocks .ps1 shims.
  const where = await runCommand(
    'cmd.exe',
    ['/d', '/s', '/c', `where ${quoteCmdArg(binName)}`],
    env
  );

  const stdout = String(where.stdout || '');
  const candidates = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  let resolved = selectWindowsWhereCandidate(candidates);

  // [Defensive patch] When `cmd.exe /c where` cannot find the binary, try PowerShell's
  // Get-Command as a fallback. Some Windows setups (e.g. certain winget installations or
  // environments where the binary is only visible in PowerShell's PATH) may have the
  // command available to PowerShell but not to cmd.exe. This is speculative — we are not
  // certain it resolves any specific reported issue, so it can be safely removed if it
  // proves unhelpful or causes problems.
  if (!resolved) {
    try {
      const ps = await runCommand(
        'powershell.exe',
        ['-NoProfile', '-Command', `(Get-Command ${binName} -ErrorAction SilentlyContinue).Source`],
        env
      );
      const psPath = String(ps.stdout || '').trim();
      if (ps.status === 0 && psPath) {
        resolved = psPath;
      }
    } catch {
      // Ignore — PowerShell may not be available either.
    }
  }

  if (!resolved) {
    return await runCommand(binName, args, env);
  }

  const resolvedLower = resolved.toLowerCase();
  if (
    resolvedLower.endsWith('.cmd') ||
    resolvedLower.endsWith('.bat') ||
    resolvedLower.endsWith('.com')
  ) {
    const cmdline = [quoteCmdArg(resolved), ...args.map(quoteCmdArg)].join(' ');
    return await runCommand('cmd.exe', ['/d', '/s', '/c', cmdline], env);
  }

  if (resolvedLower.endsWith('.ps1')) {
    // ExecutionPolicy can be Restricted on some machines; bypass it for this one-off invocation.
    // We also avoid loading profiles to prevent failures when the user's profile cannot be loaded.
    const cmdline = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolved, ...args].map(
      quoteCmdArg
    );
    return await runCommand('powershell.exe', cmdline, env);
  }

  return await runCommand(resolved, args, env);
}

const AUTH_FILE_DETECTED = 'configured';

function resolveHomeDir(options) {
  return options && options.homeDir != null ? options.homeDir : os.homedir();
}

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isDirectory(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Check whether Claude Code has been initialized on this machine.
 * See the .ts source for full documentation.
 */
function getClaudeConfigPath(homeDir) {
  return path.join(homeDir, '.claude.json');
}

function getClaudeHomeDir(homeDir) {
  return path.join(homeDir, '.claude');
}

function hasClaudeCredentials(options) {
  const homeDir = resolveHomeDir(options);
  return isFile(getClaudeConfigPath(homeDir)) || isDirectory(getClaudeHomeDir(homeDir));
}

function getCodexCredentialsPath(homeDir) {
  const codexHome = process.env.CODEX_HOME;
  if (codexHome && codexHome.length > 0) {
    return path.join(codexHome, 'auth.json');
  }
  return path.join(homeDir, '.codex', 'auth.json');
}

function hasCodexCredentials(options) {
  return isFile(getCodexCredentialsPath(resolveHomeDir(options)));
}

const checkClaude = (options) => {
  return hasClaudeCredentials(options) ? AUTH_FILE_DETECTED : false;
};

const checkCodex = (options) => {
  return hasCodexCredentials(options) ? AUTH_FILE_DETECTED : false;
};

const checkOpencode = async () => {
  try {
    const additionalPaths = process.platform === 'win32' ? getWindowsGlobalBinPaths() : [];
    const PATH = buildAugmentedPath(additionalPaths, process.env.PATH);
    const env = { ...process.env, PATH };

    const { stdout, status, error } =
      process.platform === 'win32'
        ? await runWindowsCommandResolved('opencode', ['-v'], env)
        : await runCommand('opencode', ['-v'], env);

    if (status !== 0 || error) return false;
    return parseRawVersion(String(stdout || ''));
  } catch {
    return false;
  }
};

const checkKimi = async () => {
  try {
    const additionalPaths = process.platform === 'win32' ? getWindowsGlobalBinPaths() : [];
    const PATH = buildAugmentedPath(additionalPaths, process.env.PATH);
    const env = { ...process.env, PATH };

    const { stdout, status, error } =
      process.platform === 'win32'
        ? await runWindowsCommandResolved('kimi', ['-V'], env)
        : await runCommand('kimi', ['-V'], env);

    if (status !== 0 || error) return false;
    return parseRawVersion(String(stdout || ''));
  } catch {
    return false;
  }
};

function detectCliTypes(options) {
  const kimi = 'managed-runtime';
  const grok = 'managed-runtime';
  const claude = checkClaude(options);
  const codex = checkCodex(options);
  const available = ['kimi', 'grok'];
  if (claude) available.push('claude');
  if (codex) available.push('codex');
  return {
    kimi,
    grok,
    claude: claude || null,
    codex: codex || null,
    available,
  };
}

module.exports = {
  checkClaude,
  checkCodex,
  checkOpencode,
  checkKimi,
  detectCliTypes,
  __test__: {
    resolveHomeDir,
    selectWindowsWhereCandidate,
    parseRawVersion,
    getClaudeConfigPath,
    getClaudeHomeDir,
    getCodexCredentialsPath,
    hasClaudeCredentials,
    hasCodexCredentials,
  },
};
