import iconv from 'iconv-lite';

/**
 * Windows OEM code page mapping by locale.
 * These are the most common code pages for different language versions of Windows.
 *
 * Reference: https://docs.microsoft.com/en-us/windows/win32/intl/code-page-identifiers
 */
const WINDOWS_OEM_CODE_PAGES: Record<string, string> = {
  // East Asian
  'zh-CN': 'cp936', // Simplified Chinese (GBK)
  'zh-TW': 'cp950', // Traditional Chinese (Big5)
  'zh-HK': 'cp950', // Traditional Chinese (Big5)
  'ja-JP': 'cp932', // Japanese (Shift-JIS)
  'ko-KR': 'cp949', // Korean

  // Cyrillic
  'ru-RU': 'cp866', // Russian
  'uk-UA': 'cp866', // Ukrainian
  'bg-BG': 'cp866', // Bulgarian

  // Western European
  'en-US': 'cp437', // US English (DOS)
  'de-DE': 'cp850', // German
  'fr-FR': 'cp850', // French
  'es-ES': 'cp850', // Spanish
  'it-IT': 'cp850', // Italian
  'pt-BR': 'cp850', // Portuguese (Brazil)
  'pt-PT': 'cp850', // Portuguese (Portugal)

  // Central/Eastern European
  'pl-PL': 'cp852', // Polish
  'cs-CZ': 'cp852', // Czech
  'hu-HU': 'cp852', // Hungarian
  'ro-RO': 'cp852', // Romanian

  // Other
  'tr-TR': 'cp857', // Turkish
  'he-IL': 'cp862', // Hebrew
  'ar-SA': 'cp720', // Arabic
  'th-TH': 'cp874', // Thai
  'vi-VN': 'cp1258', // Vietnamese
};

/**
 * Default OEM code page when locale cannot be determined.
 * CP437 is the original IBM PC code page.
 */
const DEFAULT_OEM_CODE_PAGE = 'cp437';

/**
 * Cached system locale (detected once at startup).
 */
let cachedLocale: string | null = null;

/**
 * Cached OEM code page for the current system.
 */
let cachedOemCodePage: string | null = null;

/**
 * Detects the system locale from environment variables.
 *
 * On Windows, the locale can be determined from:
 * - LANG environment variable (if set by user)
 * - LC_ALL environment variable
 * - LOCALE environment variable
 * - PowerShell's $PSCulture (not directly accessible)
 *
 * Falls back to 'en-US' if no locale can be detected.
 */
function detectSystemLocale(): string {
  if (cachedLocale !== null) {
    return cachedLocale;
  }

  // Check common environment variables for locale
  const envLocale =
    process.env.LANG || process.env.LC_ALL || process.env.LC_CTYPE || process.env.LOCALE;

  if (envLocale) {
    // Parse locale string (e.g., "zh_CN.UTF-8" -> "zh-CN")
    const match = envLocale.match(/^([a-z]{2})[-_]([A-Z]{2})/i);
    if (match && match[1] && match[2]) {
      cachedLocale = `${match[1].toLowerCase()}-${match[2].toUpperCase()}`;
      return cachedLocale;
    }
  }

  // On Windows without LANG set, try to infer from other indicators
  // This is a best-effort approach
  if (process.platform === 'win32') {
    // Check if running in a Chinese environment (common case)
    // Windows sets some environment variables that can hint at the locale
    const systemRoot = process.env.SystemRoot || '';
    if (systemRoot.includes('\\Windows')) {
      // Default to Chinese for now if on Windows without explicit locale
      // This could be improved by checking registry or using native APIs
      // For now, we'll use a safe default
    }
  }

  // Default fallback
  cachedLocale = 'en-US';
  return cachedLocale;
}

/**
 * Gets the OEM code page for the current Windows system.
 *
 * The OEM code page is used by console applications (cmd.exe, etc.)
 * for stdout/stderr output. This differs from the ANSI code page
 * used by GUI applications.
 */
export function getWindowsOemCodePage(): string {
  if (cachedOemCodePage !== null) {
    return cachedOemCodePage;
  }

  const locale = detectSystemLocale();
  cachedOemCodePage = WINDOWS_OEM_CODE_PAGES[locale] || DEFAULT_OEM_CODE_PAGE;
  return cachedOemCodePage;
}

/**
 * Checks if a buffer contains valid UTF-8 data.
 *
 * This uses a heuristic approach:
 * 1. Check for UTF-8 BOM
 * 2. Validate UTF-8 byte sequences
 * 3. Check for common non-UTF-8 patterns
 *
 * @param buffer - The buffer to check
 * @returns true if the buffer appears to be valid UTF-8
 */
export function isValidUtf8(buffer: Buffer): boolean {
  // Empty buffer is valid UTF-8
  if (buffer.length === 0) {
    return true;
  }

  // Check for UTF-8 BOM
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    // Has UTF-8 BOM, likely UTF-8
    return true;
  }

  // Validate UTF-8 byte sequences
  let i = 0;
  while (i < buffer.length) {
    const byte = buffer[i];
    if (byte === undefined) break;

    if (byte <= 0x7f) {
      // ASCII (0x00-0x7F)
      i++;
    } else if ((byte & 0xe0) === 0xc0) {
      // 2-byte sequence (0xC0-0xDF)
      if (i + 1 >= buffer.length) return false;
      const byte2 = buffer[i + 1];
      if (byte2 === undefined || (byte2 & 0xc0) !== 0x80) return false;
      // Check for overlong encoding
      if (byte < 0xc2) return false;
      i += 2;
    } else if ((byte & 0xf0) === 0xe0) {
      // 3-byte sequence (0xE0-0xEF)
      if (i + 2 >= buffer.length) return false;
      const byte2 = buffer[i + 1];
      const byte3 = buffer[i + 2];
      if (byte2 === undefined || byte3 === undefined) return false;
      if ((byte2 & 0xc0) !== 0x80 || (byte3 & 0xc0) !== 0x80) return false;
      // Check for overlong encoding and surrogate pairs
      const codePoint = ((byte & 0x0f) << 12) | ((byte2 & 0x3f) << 6) | (byte3 & 0x3f);
      if (codePoint < 0x800 || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return false;
      i += 3;
    } else if ((byte & 0xf8) === 0xf0) {
      // 4-byte sequence (0xF0-0xF7)
      if (i + 3 >= buffer.length) return false;
      const byte2 = buffer[i + 1];
      const byte3 = buffer[i + 2];
      const byte4 = buffer[i + 3];
      if (byte2 === undefined || byte3 === undefined || byte4 === undefined) return false;
      if ((byte2 & 0xc0) !== 0x80 || (byte3 & 0xc0) !== 0x80 || (byte4 & 0xc0) !== 0x80)
        return false;
      // Check for overlong encoding and valid range
      const codePoint =
        ((byte & 0x07) << 18) | ((byte2 & 0x3f) << 12) | ((byte3 & 0x3f) << 6) | (byte4 & 0x3f);
      if (codePoint < 0x10000 || codePoint > 0x10ffff) return false;
      i += 4;
    } else {
      // Invalid UTF-8 start byte
      return false;
    }
  }

  return true;
}

/**
 * Decodes a buffer to a string, handling Windows encoding issues.
 *
 * On Windows, child process output may use the system OEM code page
 * (e.g., CP936 for Simplified Chinese) instead of UTF-8. This function
 * attempts to detect and handle this by:
 *
 * 1. First trying to decode as UTF-8
 * 2. If the buffer doesn't look like valid UTF-8 and we're on Windows,
 *    falling back to the system's OEM code page
 *
 * @param buffer - The buffer to decode
 * @param forceEncoding - Optional encoding to force (bypasses detection)
 * @returns The decoded string
 */
export function decodeBuffer(buffer: Buffer, forceEncoding?: string): string {
  // Empty buffer
  if (buffer.length === 0) {
    return '';
  }

  // If a specific encoding is forced, use it
  if (forceEncoding) {
    return iconv.decode(buffer, forceEncoding);
  }

  // On non-Windows platforms, always use UTF-8
  if (process.platform !== 'win32') {
    return buffer.toString('utf8');
  }

  // On Windows, check if the buffer is valid UTF-8
  if (isValidUtf8(buffer)) {
    return buffer.toString('utf8');
  }

  // Buffer is not valid UTF-8, use the system's OEM code page
  const codePage = getWindowsOemCodePage();
  return iconv.decode(buffer, codePage);
}

/**
 * Sets the cached OEM code page for testing purposes.
 *
 * @param codePage - The code page to set (e.g., 'cp936', 'utf8')
 */
export function setWindowsOemCodePageForTesting(codePage: string | null): void {
  cachedOemCodePage = codePage;
}

/**
 * Sets the cached locale for testing purposes.
 *
 * @param locale - The locale to set (e.g., 'zh-CN', 'en-US')
 */
export function setLocaleForTesting(locale: string | null): void {
  cachedLocale = locale;
}
