/** A targeted reader for the EC2 query protocol's XML responses.
 *
 * Workers have no `DOMParser`, and core may not import npm packages (see
 * `test/core-imports.test.ts`), so this is a deliberately small element-tree
 * scanner: element names, direct text, and nesting. Attributes, namespaces,
 * and processing instructions are skipped because EC2 query responses never
 * carry data in them.
 */

export interface XmlElement {
  readonly name: string;
  /** Concatenated direct text nodes, entity-decoded and trimmed. */
  readonly text: string;
  readonly children: readonly XmlElement[];
}

interface MutableXmlElement {
  name: string;
  text: string;
  children: MutableXmlElement[];
}

const NAMED_ENTITIES: readonly (readonly [string, string])[] = [
  ["amp", "&"],
  ["apos", "'"],
  ["gt", ">"],
  ["lt", "<"],
  ["quot", '"'],
];

function decodeEntity(body: string): string | null {
  if (body.startsWith("#x") || body.startsWith("#X")) {
    const code = Number.parseInt(body.slice(2), 16);
    return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : null;
  }
  if (body.startsWith("#")) {
    const code = Number.parseInt(body.slice(1), 10);
    return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : null;
  }
  return NAMED_ENTITIES.find(([name]) => name === body)?.[1] ?? null;
}

function decodeEntities(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(
    /&(#[Xx]?[0-9A-Fa-f]+|[A-Za-z]+);/gu,
    (match: string, body: string) => decodeEntity(body) ?? match,
  );
}

/** Element name up to the first whitespace, slash, or end of the tag body. */
function elementName(tagBody: string): string {
  const end = tagBody.search(/[\s/]/u);
  return end === -1 ? tagBody : tagBody.slice(0, end);
}

function skipPast(source: string, from: number, terminator: string): number {
  const end = source.indexOf(terminator, from);
  return end === -1 ? source.length : end + terminator.length;
}

function finalize(element: MutableXmlElement): XmlElement {
  return {
    name: element.name,
    text: element.text.trim(),
    children: element.children.map(finalize),
  };
}

/** Parses the document's root element. A malformed or empty document yields an
 * element with an empty name and no children rather than throwing: callers
 * decide what a missing field means, and a partial body is already an error at
 * the transport layer. */
export function parseXml(source: string): XmlElement {
  const root: MutableXmlElement = { name: "", text: "", children: [] };
  const stack: MutableXmlElement[] = [root];
  let index = 0;
  while (index < source.length) {
    const open = source.indexOf("<", index);
    if (open === -1) break;
    const current = stack[stack.length - 1];
    if (open > index && current !== undefined) {
      current.text += decodeEntities(source.slice(index, open));
    }
    if (source.startsWith("<!--", open)) {
      index = skipPast(source, open, "-->");
      continue;
    }
    if (source.startsWith("<![CDATA[", open)) {
      const end = source.indexOf("]]>", open);
      const stop = end === -1 ? source.length : end;
      if (current !== undefined) current.text += source.slice(open + 9, stop);
      index = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<?", open)) {
      index = skipPast(source, open, "?>");
      continue;
    }
    if (source.startsWith("<!", open)) {
      index = skipPast(source, open, ">");
      continue;
    }
    const close = source.indexOf(">", open);
    if (close === -1) break;
    const tagBody = source.slice(open + 1, close);
    index = close + 1;
    if (tagBody.startsWith("/")) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const element: MutableXmlElement = { name: elementName(tagBody), text: "", children: [] };
    if (current !== undefined) current.children.push(element);
    if (!tagBody.endsWith("/")) stack.push(element);
  }
  const document = root.children[0];
  return finalize(document ?? root);
}

export function childElement(element: XmlElement, name: string): XmlElement | null {
  return element.children.find((child) => child.name === name) ?? null;
}

export function childElements(element: XmlElement, name: string): readonly XmlElement[] {
  return element.children.filter((child) => child.name === name);
}

export function childText(element: XmlElement, name: string): string | null {
  return childElement(element, name)?.text ?? null;
}

/** EC2 wraps every list as `<somethingSet><item>…</item></somethingSet>`. */
export function setItems(element: XmlElement, setName: string): readonly XmlElement[] {
  const set = childElement(element, setName);
  return set === null ? [] : childElements(set, "item");
}
