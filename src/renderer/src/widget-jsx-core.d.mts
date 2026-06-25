export function hashSource(source: string, lang: string): string
export function b64EncodeUtf8(s: string): string
export function compileJsxSource(
  transform: (
    src: string,
    opts: { transforms: ('jsx' | 'typescript')[]; jsxRuntime: 'automatic'; production: boolean }
  ) => { code: string },
  source: string,
  lang: string
): { ok: true; js: string } | { ok: false; error: string }
export function buildImportMapScript(registry: Record<string, string>): string
export function composeJsxSrcdoc(compiledJs: string, registry: Record<string, string>): string
export function errorCardHtml(message: string, lang: string): string
