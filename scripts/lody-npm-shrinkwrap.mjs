import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// This is a narrow pnpm lockfile v9 reader for Lody's production graph. The
// Docker builder copies only the vendored tree and these scripts, so a general
// YAML dependency would add another unreviewed build input. Unsupported
// registry shapes fail closed instead of falling back to semver resolution.
const IMPORTER = "apps/cli";
const DEPENDENCY_GROUPS = new Set(["dependencies", "optionalDependencies"]);

function indentation(line) {
  return line.length - line.trimStart().length;
}

function splitMapping(line, expectedIndent) {
  if (indentation(line) !== expectedIndent) return null;
  const source = line.trim();
  let quote = null;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote === "'") {
      if (character === "'" && source[index + 1] === "'") index += 1;
      else if (character === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (character === "\\") index += 1;
      else if (character === '"') quote = null;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === ":") {
      return {
        key: yamlScalar(source.slice(0, index)),
        value: source.slice(index + 1).trim(),
      };
    }
  }
  return null;
}

function yamlScalar(source) {
  const value = source.trim();
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (value.startsWith('"') && value.endsWith('"')) return JSON.parse(value);
  return value;
}

function inlineFields(source) {
  if (!source.startsWith("{") || !source.endsWith("}")) return new Map();
  const fields = new Map();
  for (const item of source.slice(1, -1).split(/,\s*/u)) {
    const mapping = splitMapping(item, 0);
    if (mapping !== null) fields.set(mapping.key, yamlScalar(mapping.value));
  }
  return fields;
}

function inlineList(source) {
  if (!source.startsWith("[") || !source.endsWith("]")) return undefined;
  const body = source.slice(1, -1).trim();
  return body === "" ? [] : body.split(/,\s*/u).map(yamlScalar);
}

function parsePnpmLock(source) {
  const lines = source.split(/\r?\n/u);
  const versionLine = lines.find((line) => line.startsWith("lockfileVersion:"));
  if (versionLine === undefined || yamlScalar(versionLine.split(":").slice(1).join(":")) !== "9.0") {
    throw new Error("the Lody npm shrinkwrap generator requires pnpm lockfile version 9.0");
  }

  const importerDependencies = new Map();
  const catalogSpecifiers = new Map();
  const packageMetadata = new Map();
  const snapshots = new Map();
  let section = "";
  let importer = "";
  let importerGroup = "";
  let importerDependency = "";
  let catalog = "";
  let catalogDependency = "";
  let packageKey = "";
  let snapshotKey = "";
  let snapshotGroup = "";

  for (const line of lines) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (indentation(line) === 0) {
      const top = splitMapping(line, 0);
      section = top?.key ?? "";
      continue;
    }

    if (section === "catalogs") {
      const atTwo = splitMapping(line, 2);
      if (atTwo !== null) {
        catalog = atTwo.key;
        catalogDependency = "";
        continue;
      }
      if (catalog !== "default") continue;
      const atFour = splitMapping(line, 4);
      if (atFour !== null) {
        catalogDependency = atFour.key;
        continue;
      }
      const atSix = splitMapping(line, 6);
      if (atSix?.key === "specifier" && catalogDependency !== "") {
        catalogSpecifiers.set(catalogDependency, yamlScalar(atSix.value));
      }
      continue;
    }

    if (section === "importers") {
      const atTwo = splitMapping(line, 2);
      if (atTwo !== null) {
        importer = atTwo.key;
        importerGroup = "";
        importerDependency = "";
        continue;
      }
      if (importer !== IMPORTER) continue;
      const atFour = splitMapping(line, 4);
      if (atFour !== null) {
        importerGroup = atFour.key;
        importerDependency = "";
        continue;
      }
      if (importerGroup !== "dependencies") continue;
      const atSix = splitMapping(line, 6);
      if (atSix !== null) {
        importerDependency = atSix.key;
        continue;
      }
      const atEight = splitMapping(line, 8);
      if (atEight?.key === "version" && importerDependency !== "") {
        importerDependencies.set(importerDependency, yamlScalar(atEight.value));
      }
      continue;
    }

    if (section === "packages") {
      const atTwo = splitMapping(line, 2);
      if (atTwo !== null) {
        packageKey = atTwo.key;
        packageMetadata.set(packageKey, {});
        continue;
      }
      const atFour = splitMapping(line, 4);
      if (atFour === null || packageKey === "") continue;
      const metadata = packageMetadata.get(packageKey);
      if (atFour.key === "resolution") {
        const resolution = inlineFields(atFour.value);
        metadata.integrity = resolution.get("integrity");
        metadata.tarball = resolution.get("tarball");
      } else if (["cpu", "os", "libc"].includes(atFour.key)) {
        metadata[atFour.key] = inlineList(atFour.value);
      } else if (atFour.key === "hasBin") {
        metadata.hasBin = atFour.value === "true";
      }
      continue;
    }

    if (section === "snapshots") {
      const atTwo = splitMapping(line, 2);
      if (atTwo !== null) {
        snapshotKey = atTwo.key;
        snapshotGroup = "";
        snapshots.set(snapshotKey, {
          dependencies: new Map(),
          optionalDependencies: new Map(),
        });
        continue;
      }
      const atFour = splitMapping(line, 4);
      if (atFour !== null) {
        snapshotGroup = DEPENDENCY_GROUPS.has(atFour.key) ? atFour.key : "";
        continue;
      }
      const atSix = splitMapping(line, 6);
      if (atSix !== null && snapshotKey !== "" && snapshotGroup !== "") {
        snapshots.get(snapshotKey)[snapshotGroup].set(
          atSix.key,
          yamlScalar(atSix.value),
        );
      }
    }
  }
  if (importerDependencies.size === 0) {
    throw new Error(`pnpm-lock.yaml has no production dependencies for ${IMPORTER}`);
  }
  return { catalogSpecifiers, importerDependencies, packageMetadata, snapshots };
}

function packageIdentity(snapshotKey) {
  const peerContext = snapshotKey.indexOf("(");
  const bare = peerContext === -1 ? snapshotKey : snapshotKey.slice(0, peerContext);
  const separator = bare.lastIndexOf("@");
  if (separator <= 0 || separator === bare.length - 1) {
    throw new Error(`cannot parse pnpm package identity ${snapshotKey}`);
  }
  return { name: bare.slice(0, separator), version: bare.slice(separator + 1) };
}

function snapshotKeyFor(name, reference, snapshots) {
  if (/^(?:link|file|workspace|npm):/u.test(reference)) {
    throw new Error(`unsupported non-registry Lody runtime dependency ${name}: ${reference}`);
  }
  const key = `${name}@${reference}`;
  if (!snapshots.has(key)) {
    throw new Error(`pnpm-lock.yaml has no snapshot for ${key}`);
  }
  return key;
}

function registryTarball(name, version) {
  const base = name.startsWith("@") ? name.slice(name.indexOf("/") + 1) : name;
  return `https://registry.npmjs.org/${name}/-/${base}-${version}.tgz`;
}

function compareEntries([left], [right]) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedObject(entries) {
  return Object.fromEntries([...entries].sort(compareEntries));
}

function dependencyObject(dependencies) {
  return sortedObject([...dependencies].map(([name, reference]) => [
    name,
    packageIdentity(`${name}@${reference}`).version,
  ]));
}

function packageLockEntry(graph, key, optional, ignoredBuilds) {
  const node = graph.get(key);
  const entry = {
    version: node.version,
    resolved: node.tarball ?? registryTarball(node.name, node.version),
    integrity: node.integrity,
  };
  if (node.dependencies.size > 0) {
    entry.dependencies = dependencyObject(node.dependencies);
  }
  if (node.optionalDependencies.size > 0) {
    entry.optionalDependencies = dependencyObject(node.optionalDependencies);
  }
  for (const field of ["cpu", "os", "libc"]) {
    if (node[field] !== undefined) entry[field] = node[field];
  }
  if (node.hasBin) entry.hasBin = true;
  // npm synthesizes node-gyp rebuild when a package has binding.gyp but no
  // install script. Preserve pnpm's explicit decision to ignore that build.
  if (ignoredBuilds.has(node.name)) entry.gypfile = false;
  if (optional) entry.optional = true;
  return entry;
}

function runtimeGraph(parsed) {
  const graph = new Map();
  const optionalByKey = new Map();
  const queue = [...parsed.importerDependencies].map(([name, reference]) => ({
    key: snapshotKeyFor(name, reference, parsed.snapshots),
    optional: false,
  }));
  while (queue.length > 0) {
    const current = queue.shift();
    const knownOptional = optionalByKey.get(current.key);
    if (knownOptional === false || knownOptional === current.optional) continue;
    optionalByKey.set(current.key, current.optional);
    const identity = packageIdentity(current.key);
    const metadataKey = `${identity.name}@${identity.version}`;
    const metadata = parsed.packageMetadata.get(metadataKey);
    const snapshot = parsed.snapshots.get(current.key);
    if (metadata?.integrity === undefined) {
      throw new Error(`pnpm-lock.yaml has no integrity for ${metadataKey}`);
    }
    const node = {
      ...identity,
      ...metadata,
      dependencies: snapshot.dependencies,
      optionalDependencies: snapshot.optionalDependencies,
    };
    graph.set(current.key, node);
    for (const [name, reference] of snapshot.dependencies) {
      queue.push({
        key: snapshotKeyFor(name, reference, parsed.snapshots),
        optional: current.optional,
      });
    }
    for (const [name, reference] of snapshot.optionalDependencies) {
      queue.push({
        key: snapshotKeyFor(name, reference, parsed.snapshots),
        optional: true,
      });
    }
  }
  return { graph, optionalByKey };
}

function packageLocations(parsed, graph, optionalByKey) {
  const variants = new Map();
  for (const [key, node] of graph) {
    const found = variants.get(node.name) ?? [];
    found.push(key);
    variants.set(node.name, found);
  }
  const directKeys = new Map(
    [...parsed.importerDependencies].map(([name, reference]) => [
      name,
      snapshotKeyFor(name, reference, parsed.snapshots),
    ]),
  );
  const defaults = new Map();
  for (const [name, keys] of variants) {
    defaults.set(name, directKeys.get(name) ?? keys.sort()[0]);
  }

  const entries = new Map();
  const expanded = new Set();
  const globalScope = new Map(defaults);
  const add = (location, key, optional, scope) => {
    const existing = entries.get(location);
    if (existing !== undefined && existing.key !== key) {
      throw new Error(`npm placement conflict at ${location}`);
    }
    const effectiveOptional = (existing?.optional ?? true) && optional;
    entries.set(location, { key, optional: effectiveOptional });
    const expansion = `${location}\0${effectiveOptional ? "optional" : "required"}`;
    if (expanded.has(expansion)) return;
    expanded.add(expansion);
    const node = graph.get(key);
    const childScope = new Map(scope);
    childScope.set(node.name, key);
    for (const [group, edgeOptional] of [
      ["dependencies", false],
      ["optionalDependencies", true],
    ]) {
      for (const [name, reference] of node[group]) {
        const childKey = snapshotKeyFor(name, reference, parsed.snapshots);
        if (childScope.get(name) === childKey) continue;
        const childLocation = `${location}/node_modules/${name}`;
        add(childLocation, childKey, effectiveOptional || edgeOptional, childScope);
      }
    }
  };

  for (const [name, key] of [...defaults].sort(compareEntries)) {
    add(`node_modules/${name}`, key, optionalByKey.get(key) ?? false, globalScope);
  }
  return entries;
}

export function createLodyNpmShrinkwrap(
  lockfileSource,
  packageJson,
  ignoredBuilds = new Set(),
) {
  const parsed = parsePnpmLock(lockfileSource);
  const packageDependencies = packageJson.dependencies ?? {};
  const importerNames = [...parsed.importerDependencies.keys()].sort();
  const packageNames = Object.keys(packageDependencies).sort();
  if (JSON.stringify(importerNames) !== JSON.stringify(packageNames)) {
    throw new Error("apps/cli package.json production dependencies differ from pnpm-lock.yaml");
  }
  const publishedDependencies = new Map(
    Object.entries(packageDependencies).map(([name, specifier]) => {
      if (specifier !== "catalog:") return [name, specifier];
      const published = parsed.catalogSpecifiers.get(name);
      if (published === undefined) {
        throw new Error(`pnpm-lock.yaml has no default catalog specifier for ${name}`);
      }
      return [name, published];
    }),
  );
  const { graph, optionalByKey } = runtimeGraph(parsed);
  const locations = packageLocations(parsed, graph, optionalByKey);
  const packages = new Map([
    ["", {
      name: packageJson.name,
      version: packageJson.version,
      dependencies: sortedObject(publishedDependencies),
    }],
  ]);
  for (const [location, placed] of [...locations].sort(compareEntries)) {
    packages.set(
      location,
      packageLockEntry(graph, placed.key, placed.optional, ignoredBuilds),
    );
  }
  return {
    name: packageJson.name,
    version: packageJson.version,
    lockfileVersion: 3,
    requires: true,
    packages: Object.fromEntries(packages),
  };
}

export function pnpmIgnoredBuildDependencies(source) {
  const names = new Set();
  let inIgnoredBuilds = false;
  for (const line of source.split(/\r?\n/u)) {
    if (indentation(line) === 0) {
      inIgnoredBuilds = line.trim() === "ignoredBuiltDependencies:";
      continue;
    }
    if (!inIgnoredBuilds || indentation(line) !== 2) continue;
    const item = /^-\s+(.+)$/u.exec(line.trim())?.[1];
    if (item !== undefined) names.add(yamlScalar(item));
  }
  return names;
}

export function writeLodyNpmShrinkwrap(lodyRoot) {
  const packageFile = path.join(lodyRoot, "apps/cli/package.json");
  const packageJson = JSON.parse(readFileSync(packageFile, "utf8"));
  const shrinkwrap = createLodyNpmShrinkwrap(
    readFileSync(path.join(lodyRoot, "pnpm-lock.yaml"), "utf8"),
    packageJson,
    pnpmIgnoredBuildDependencies(
      readFileSync(path.join(lodyRoot, "pnpm-workspace.yaml"), "utf8"),
    ),
  );
  packageJson.dependencies = shrinkwrap.packages[""].dependencies;
  delete packageJson.devDependencies;
  writeFileSync(packageFile, `${JSON.stringify(packageJson, null, 2)}\n`);
  const file = path.join(lodyRoot, "apps/cli/npm-shrinkwrap.json");
  writeFileSync(file, `${JSON.stringify(shrinkwrap, null, 2)}\n`);
  return shrinkwrap;
}
