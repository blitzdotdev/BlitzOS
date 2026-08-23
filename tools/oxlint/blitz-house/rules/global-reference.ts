import type { ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins";

function resolveVariable(
  sourceCode: SourceCode,
  identifier: ESTree.IdentifierReference,
): Variable | null {
  let scope: Scope | null = sourceCode.getScope(identifier);
  while (scope !== null) {
    const variable = scope.set.get(identifier.name);
    if (variable !== undefined) return variable;
    scope = scope.upper;
  }
  return null;
}

export function isUnshadowedGlobal(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
  name: string,
): expression is ESTree.IdentifierReference {
  if (expression.type !== "Identifier" || expression.name !== name) return false;
  if (sourceCode.isGlobalReference(expression)) return true;
  const variable = resolveVariable(sourceCode, expression);
  return variable === null || variable.defs.length === 0;
}

const GLOBAL_OWNERS = new Set(["globalThis", "self", "window"]);

/**
 * Whether the expression evaluates to the global value `name`: the bare
 * unshadowed identifier, or a `.name`/`["name"]` member access on an
 * unshadowed `globalThis`, `self`, or `window`.
 */
export function isGlobalValue(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
  name: string,
): boolean {
  if (expression.type === "Identifier") {
    return isUnshadowedGlobal(sourceCode, expression, name);
  }
  if (expression.type !== "MemberExpression" || expression.object.type !== "Identifier") {
    return false;
  }
  if (
    !GLOBAL_OWNERS.has(expression.object.name) ||
    !isUnshadowedGlobal(sourceCode, expression.object, expression.object.name)
  ) {
    return false;
  }
  return expression.computed
    ? expression.property.type === "Literal" && expression.property.value === name
    : expression.property.type === "Identifier" && expression.property.name === name;
}
