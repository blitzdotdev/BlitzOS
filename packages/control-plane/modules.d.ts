/** Markdown imported as a Text module (see the `[[rules]]` block in
 * wrangler.toml). The Worker cannot read files at runtime, so the one document
 * it has to ship — the box-image agent-rules skeleton — rides in the bundle as
 * a module whose default export is its bytes. */
declare module "*.md" {
  const content: string;
  export default content;
}
