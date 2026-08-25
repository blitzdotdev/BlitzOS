export interface RepoUrlLine {
  /** The line as typed, trimmed. Names the line in a problem message. */
  raw: string;
  /** "owner/name" when the line parses. null when it does not. */
  repo: string | null;
  /** Why the line did not parse. null when it did. */
  problem: string | null;
}

const REPO_SEGMENT = /^[A-Za-z0-9_.-]+$/u;
// Keep this shape tied to packages/control-plane/core/template-repos.ts.
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

const NOT_GITHUB = 'only github.com repositories can be cloned';
const EXTRA_PATH = 'drop the path after the repository name';
const NOT_REPOSITORY = 'not a repository URL';

function stripCloneSuffix(value: string): string {
  const withoutSlash = value.endsWith('/') ? value.slice(0, -1) : value;
  return withoutSlash.endsWith('.git') ? withoutSlash.slice(0, -4) : withoutSlash;
}

function pathProblem(path: string): string {
  const parts = path.split('/');
  if (
    parts.length > 2
    && REPO_SEGMENT.test(parts[0] ?? '')
    && REPO_SEGMENT.test(parts[1] ?? '')
  ) {
    return EXTRA_PATH;
  }
  return NOT_REPOSITORY;
}

function parsed(raw: string, path: string): RepoUrlLine {
  return REPO.test(path)
    ? { raw, repo: path, problem: null }
    : { raw, repo: null, problem: pathProblem(path) };
}

function fromHost(raw: string, host: string, path: string): RepoUrlLine {
  const lowerHost = host.toLowerCase();
  if (lowerHost !== 'github.com' && lowerHost !== 'www.github.com') {
    return { raw, repo: null, problem: NOT_GITHUB };
  }
  return parsed(raw, path);
}

function parseLine(raw: string): RepoUrlLine {
  const value = stripCloneSuffix(raw);

  const web = /^https?:\/\/([^/]+)\/(.*)$/iu.exec(value);
  if (web !== null) return fromHost(raw, web[1] ?? '', web[2] ?? '');

  const ssh = /^ssh:\/\/git@([^/]+)\/(.*)$/iu.exec(value);
  if (ssh !== null) return fromHost(raw, ssh[1] ?? '', ssh[2] ?? '');

  const git = /^git@([^:]+):(.*)$/iu.exec(value);
  if (git !== null) return fromHost(raw, git[1] ?? '', git[2] ?? '');

  const github = /^(www\.)?github\.com\/(.*)$/iu.exec(value);
  if (github !== null) return parsed(raw, github[2] ?? '');

  const possibleHost = /^([^/]+)\/(.+\/.+)$/u.exec(value);
  if (possibleHost !== null && possibleHost[1]?.includes('.')) {
    return { raw, repo: null, problem: NOT_GITHUB };
  }

  return parsed(raw, value);
}

export function parseRepoUrlLines(text: string): RepoUrlLine[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map(parseLine);
}
