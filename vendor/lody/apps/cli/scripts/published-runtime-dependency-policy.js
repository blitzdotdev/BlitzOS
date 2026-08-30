const exactSemverSpecifierPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export function collectRuntimeDependencyVersionIssues({
  dependencyBlocks,
  exactDependencies,
  pinnedDependencies,
}) {
  const issues = [];

  for (const dependencyName of exactDependencies) {
    const actualVersion = findPublishedDependencyVersion(dependencyBlocks, dependencyName);
    if (!isExactSemverSpecifier(actualVersion)) {
      issues.push({
        dependencyName,
        expectedVersion: 'an exact semantic version',
        actualVersion,
      });
    }
  }

  for (const [dependencyName, expectedVersion] of pinnedDependencies) {
    const actualVersion = findPublishedDependencyVersion(dependencyBlocks, dependencyName);
    if (actualVersion !== expectedVersion) {
      issues.push({ dependencyName, expectedVersion, actualVersion });
    }
  }

  return issues;
}

export function isExactSemverSpecifier(value) {
  return typeof value === 'string' && exactSemverSpecifierPattern.test(value);
}

function findPublishedDependencyVersion(dependencyBlocks, dependencyName) {
  for (const dependencies of dependencyBlocks) {
    const version = dependencies?.[dependencyName];
    if (typeof version === 'string') {
      return version;
    }
  }

  return null;
}
