type MdastNode = {
  type: string;
  value?: string;
  data?: Record<string, unknown>;
  children?: MdastNode[];
};

type InlineMathNode = MdastNode & {
  type: 'inlineMath';
  value: string;
  data: {
    hName: 'code';
    hProperties: { className: ['language-math', 'math-inline'] };
    hChildren: [{ type: 'text'; value: string }];
  };
};

const SKIP_CHILDREN_NODE_TYPES = new Set([
  'code',
  'definition',
  'html',
  'image',
  'imageReference',
  'inlineCode',
  'inlineMath',
  'link',
  'linkReference',
  'math',
]);

const isEscapedAt = (value: string, index: number): boolean => {
  let slashCount = 0;

  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
    slashCount += 1;
  }

  return slashCount % 2 === 1;
};

const isSingleDollarDelimiter = (value: string, index: number): boolean =>
  value[index] === '$' &&
  value[index - 1] !== '$' &&
  value[index + 1] !== '$' &&
  !isEscapedAt(value, index);

const findClosingSingleDollar = (value: string, start: number): number | null => {
  for (let index = start; index < value.length; index += 1) {
    if (isSingleDollarDelimiter(value, index)) {
      return index;
    }
  }

  return null;
};

const createInlineMathNode = (value: string): InlineMathNode => ({
  type: 'inlineMath',
  value,
  data: {
    hName: 'code',
    hProperties: { className: ['language-math', 'math-inline'] },
    hChildren: [{ type: 'text', value }],
  },
});

const splitSingleDollarMathText = (value: string): MdastNode[] | null => {
  if (!value.includes('$')) {
    return null;
  }

  const nodes: MdastNode[] = [];
  let cursor = 0;

  for (let index = 0; index < value.length; index += 1) {
    if (!isSingleDollarDelimiter(value, index)) {
      continue;
    }

    const close = findClosingSingleDollar(value, index + 1);
    if (close == null) {
      continue;
    }

    const mathValue = value.slice(index + 1, close);
    if (!mathValue.trim()) {
      continue;
    }

    if (index > cursor) {
      nodes.push({ type: 'text', value: value.slice(cursor, index) });
    }
    nodes.push(createInlineMathNode(mathValue));

    cursor = close + 1;
    index = close;
  }

  if (nodes.length === 0) {
    return null;
  }

  if (cursor < value.length) {
    nodes.push({ type: 'text', value: value.slice(cursor) });
  }

  return nodes;
};

// Keep Streamdown's default `$$...$$` parser authoritative, then add a narrow
// AST pass for AI-style `$...$`. Rejected: raw-source masking makes link/code
// precedence depend on sentinel characters instead of the parsed Markdown tree.
export const remarkSingleDollarTextMath = () => {
  const walk = (node: MdastNode) => {
    if (!Array.isArray(node.children) || SKIP_CHILDREN_NODE_TYPES.has(node.type)) {
      return;
    }

    const children = node.children;
    // Rebuild the children array only when a text node actually splits into
    // math nodes. Most nodes contain no `$`, so on the streaming re-parse hot
    // path this avoids allocating a throwaway array for every container node.
    let nextChildren: MdastNode[] | null = null;

    children.forEach((child, index) => {
      if (child.type === 'text' && typeof child.value === 'string') {
        const replacement = splitSingleDollarMathText(child.value);
        if (replacement) {
          if (!nextChildren) nextChildren = children.slice(0, index);
          nextChildren.push(...replacement);
        } else {
          nextChildren?.push(child);
        }
        return;
      }

      walk(child);
      nextChildren?.push(child);
    });

    if (nextChildren) {
      node.children = nextChildren;
    }
  };

  return (tree: unknown) => {
    if (typeof tree === 'object' && tree !== null && 'type' in tree) {
      walk(tree as MdastNode);
    }
  };
};
