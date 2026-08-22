import path from "node:path";

// The module graph of the Target B (blitz.dev managed) upload set.
//
// The managed platform ships source files, not a bundle: every relative import
// in the upload set has to resolve to another uploaded file, or the platform's
// bundler silently marks it external and the deployed Worker throws on the
// first request. `bundle.ok: true` does not mean the graph is closed. This
// module is the thing that does mean it — the emitter refuses to produce an
// unclosed set (see validateUploadSet) and a vendor suite walks the same graph.

// The specifier grammar the emitter and the closure walk share. Keeping one
// pair of patterns is the point: a rewrite that disagreed with the scan would
// reintroduce exactly the drift this module exists to catch.
const STATIC_IMPORT = /\b(?:import|export)\s+(type\s+)?(?:[^"'`;]*?\s+from\s*)?["']([^"']+)["']/gu;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu;

// NodeNext writes runtime specifiers; the repo sources are correct as they are.
// The platform Loader does not map an explicit `./x.js` back to the `x.ts` it
// actually uploaded, so the emitted copies drop the extension instead.
const RUNTIME_EXTENSION = /\.(?:js|mjs|cjs)$/u;

// Candidate order for an extensionless specifier, mirroring what the Loader
// accepts. "" first so an exact uploaded path always wins.
const RESOLUTION_SUFFIXES = Object.freeze(["", ".ts", ".tsx", ".js", ".mjs", ".cjs", "/index.ts", "/index.js"]);

// Both entry points the platform loads on its own: the Worker and the schema
// file. Neither is imported by anything, so both seed the walk.
export const UPLOAD_ENTRY_POINTS = Object.freeze(["worker.ts", "teenybase.ts"]);

function locate(match, specifier, typeOnly) {
  // The specifier is the last quoted run inside the match for both patterns.
  const start = match.index + match[0].lastIndexOf(specifier);
  return { specifier, typeOnly, start, end: start + specifier.length };
}

function specifierMatches(source) {
  const found = [];
  for (const match of source.matchAll(STATIC_IMPORT)) found.push(locate(match, match[2], match[1] !== undefined));
  for (const match of source.matchAll(DYNAMIC_IMPORT)) found.push(locate(match, match[1], false));
  return found.sort((left, right) => left.start - right.start);
}

export function importSpecifiers(source) {
  return specifierMatches(source).map(({ specifier, typeOnly }) => ({ specifier, typeOnly }));
}

/** Replaces every import specifier in place, leaving all other bytes untouched. */
export function rewriteSpecifiers(source, mapSpecifier) {
  let result = "";
  let cursor = 0;
  for (const match of specifierMatches(source)) {
    if (match.start < cursor) continue;
    result += source.slice(cursor, match.start) + mapSpecifier(match.specifier);
    cursor = match.end;
  }
  return result + source.slice(cursor);
}

export function isRelative(specifier) {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

export function hasRuntimeExtension(specifier) {
  return RUNTIME_EXTENSION.test(specifier);
}

/** `./x.js` -> `./x`. Bare specifiers ("teenybase") are never touched. */
export function loaderSpecifier(specifier) {
  return isRelative(specifier) ? specifier.replace(RUNTIME_EXTENSION, "") : specifier;
}

/** Where a relative specifier points, before asking what the upload set ships. */
export function specifierTarget(importerPath, specifier) {
  return path.posix.normalize(path.posix.join(path.posix.dirname(importerPath), specifier));
}

/** The upload path a relative specifier resolves to, or null when nothing ships it. */
export function resolveUploadPath(importerPath, specifier, uploadPaths) {
  const target = specifierTarget(importerPath, specifier);
  const stripped = target.replace(RUNTIME_EXTENSION, "");
  for (const suffix of RESOLUTION_SUFFIXES) {
    const candidate = `${stripped}${suffix}`;
    if (uploadPaths.has(candidate)) return candidate;
  }
  return uploadPaths.has(target) ? target : null;
}

/**
 * Walks the emitted graph from the platform's entry points.
 * `missing` names every relative import with nothing to resolve to;
 * `unreachable` names every uploaded file no entry point can reach.
 */
export function moduleClosure(entries, entryPoints = UPLOAD_ENTRY_POINTS) {
  const sources = new Map(entries.map((entry) => [entry.path, entry.source]));
  const reachable = new Set();
  // A module imported twice (once for types, once for values) is one gap, not
  // two: key the misses so the failure lists each file-importer pair once.
  const missing = new Map();
  const queue = [];
  for (const entryPoint of entryPoints) {
    if (!sources.has(entryPoint)) {
      missing.set(`${entryPoint}\0<entry point>`, { importer: "<entry point>", specifier: entryPoint, target: entryPoint });
      continue;
    }
    reachable.add(entryPoint);
    queue.push(entryPoint);
  }
  while (queue.length > 0) {
    const importer = queue.shift();
    for (const { specifier } of importSpecifiers(sources.get(importer))) {
      if (!isRelative(specifier)) continue;
      const resolved = resolveUploadPath(importer, specifier, sources);
      if (resolved === null) {
        const target = specifierTarget(importer, specifier);
        missing.set(`${target}\0${importer}`, { importer, specifier, target });
        continue;
      }
      if (reachable.has(resolved)) continue;
      reachable.add(resolved);
      queue.push(resolved);
    }
  }
  const unreachable = entries.map((entry) => entry.path).filter((uploadPath) => !reachable.has(uploadPath));
  return {
    reachable: [...reachable].sort(),
    missing: [...missing.values()].sort((left, right) => `${left.target}${left.importer}`.localeCompare(`${right.target}${right.importer}`)),
    unreachable,
  };
}

/**
 * The operator-facing rendering of an unclosed graph. Deliberately shaped like
 * the manual closure scan in the run-2 report, because that is the output an
 * operator will already have seen: one line per file, naming the file and the
 * importer that wanted it.
 */
export function closureReport(closure) {
  const lines = [];
  if (closure.missing.length > 0) {
    lines.push(`${closure.missing.length} unresolved relative specifier(s) — add these to CORE_MANIFEST:`);
    for (const { importer, specifier, target } of closure.missing) {
      lines.push(`  MISSING ${target}\t(${specifier})\t<- ${importer}`);
    }
  }
  if (closure.unreachable.length > 0) {
    lines.push(`${closure.unreachable.length} uploaded file(s) unreachable from ${UPLOAD_ENTRY_POINTS.join(", ")}:`);
    for (const uploadPath of closure.unreachable) lines.push(`  UNREACHABLE ${uploadPath}`);
  }
  return lines.join("\n");
}

/** Throws unless the emitted set is closed. The gate the manifest lacked. */
export function assertClosedUploadSet(entries, entryPoints = UPLOAD_ENTRY_POINTS) {
  const closure = moduleClosure(entries, entryPoints);
  if (closure.missing.length === 0 && closure.unreachable.length === 0) return closure;
  throw new Error(`upload set is not a closed module graph\n${closureReport(closure)}`);
}
