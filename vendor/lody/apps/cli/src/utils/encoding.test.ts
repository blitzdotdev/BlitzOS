import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import iconv from 'iconv-lite';
import {
  decodeBuffer,
  isValidUtf8,
  getWindowsOemCodePage,
  setWindowsOemCodePageForTesting,
  setLocaleForTesting,
} from './encoding';

describe('encoding utilities', () => {
  beforeEach(() => {
    // Reset cached values before each test
    setWindowsOemCodePageForTesting(null);
    setLocaleForTesting(null);
  });

  afterEach(() => {
    // Clean up after each test
    setWindowsOemCodePageForTesting(null);
    setLocaleForTesting(null);
  });

  describe('isValidUtf8', () => {
    it('should return true for empty buffer', () => {
      expect(isValidUtf8(Buffer.alloc(0))).toBe(true);
    });

    it('should return true for ASCII-only content', () => {
      const buffer = Buffer.from('Hello, World!', 'utf8');
      expect(isValidUtf8(buffer)).toBe(true);
    });

    it('should return true for valid UTF-8 with Chinese characters', () => {
      const buffer = Buffer.from('你好世界', 'utf8');
      expect(isValidUtf8(buffer)).toBe(true);
    });

    it('should return true for valid UTF-8 with emoji', () => {
      const buffer = Buffer.from('Hello 👋 World 🌍', 'utf8');
      expect(isValidUtf8(buffer)).toBe(true);
    });

    it('should return true for valid UTF-8 with mixed content', () => {
      const buffer = Buffer.from('Hello 你好 мир 🌍', 'utf8');
      expect(isValidUtf8(buffer)).toBe(true);
    });

    it('should return true for UTF-8 BOM', () => {
      const buffer = Buffer.from([0xef, 0xbb, 0xbf, 0x48, 0x65, 0x6c, 0x6c, 0x6f]); // BOM + "Hello"
      expect(isValidUtf8(buffer)).toBe(true);
    });

    it('should return false for invalid UTF-8 (GBK encoded Chinese)', () => {
      // "你好" in GBK encoding
      const gbkBuffer = iconv.encode('你好', 'gbk');
      expect(isValidUtf8(gbkBuffer)).toBe(false);
    });

    it('should return false for invalid continuation byte', () => {
      // Invalid: continuation byte without a start byte
      const buffer = Buffer.from([0x80, 0x81]);
      expect(isValidUtf8(buffer)).toBe(false);
    });

    it('should return false for truncated multi-byte sequence', () => {
      // Start of 3-byte sequence without continuation
      const buffer = Buffer.from([0xe4, 0xbd]);
      expect(isValidUtf8(buffer)).toBe(false);
    });

    it('should return false for overlong encoding', () => {
      // Overlong encoding of ASCII 'A' (should be 0x41, not 0xC0 0x81)
      const buffer = Buffer.from([0xc0, 0x81]);
      expect(isValidUtf8(buffer)).toBe(false);
    });
  });

  describe('decodeBuffer', () => {
    it('should decode UTF-8 buffer correctly', () => {
      const buffer = Buffer.from('Hello, 你好!', 'utf8');
      expect(decodeBuffer(buffer)).toBe('Hello, 你好!');
    });

    it('should return empty string for empty buffer', () => {
      expect(decodeBuffer(Buffer.alloc(0))).toBe('');
    });

    it('should decode ASCII correctly', () => {
      const buffer = Buffer.from('Hello, World!', 'utf8');
      expect(decodeBuffer(buffer)).toBe('Hello, World!');
    });

    it('should respect forceEncoding parameter', () => {
      // "你好" in GBK
      const gbkBuffer = iconv.encode('你好', 'gbk');
      expect(decodeBuffer(gbkBuffer, 'gbk')).toBe('你好');
    });

    it('should handle GBK encoded Chinese on Windows', () => {
      // Simulate Windows environment
      const originalPlatform = process.platform;

      // We can't easily mock process.platform, so we test the forceEncoding path
      const gbkBuffer = iconv.encode('测试中文输出', 'gbk');
      expect(decodeBuffer(gbkBuffer, 'gbk')).toBe('测试中文输出');

      // Restore
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    it('should decode CP936 (GBK) correctly with forceEncoding', () => {
      const text = '这是一个测试';
      const cp936Buffer = iconv.encode(text, 'cp936');
      expect(decodeBuffer(cp936Buffer, 'cp936')).toBe(text);
    });

    it('should decode CP932 (Shift-JIS) correctly with forceEncoding', () => {
      const text = 'こんにちは';
      const cp932Buffer = iconv.encode(text, 'cp932');
      expect(decodeBuffer(cp932Buffer, 'cp932')).toBe(text);
    });

    it('should decode CP949 (Korean) correctly with forceEncoding', () => {
      const text = '안녕하세요';
      const cp949Buffer = iconv.encode(text, 'cp949');
      expect(decodeBuffer(cp949Buffer, 'cp949')).toBe(text);
    });
  });

  describe('getWindowsOemCodePage', () => {
    it('should return cp936 for zh-CN locale', () => {
      setLocaleForTesting('zh-CN');
      setWindowsOemCodePageForTesting(null); // Reset to force re-detection
      expect(getWindowsOemCodePage()).toBe('cp936');
    });

    it('should return cp950 for zh-TW locale', () => {
      setLocaleForTesting('zh-TW');
      setWindowsOemCodePageForTesting(null);
      expect(getWindowsOemCodePage()).toBe('cp950');
    });

    it('should return cp932 for ja-JP locale', () => {
      setLocaleForTesting('ja-JP');
      setWindowsOemCodePageForTesting(null);
      expect(getWindowsOemCodePage()).toBe('cp932');
    });

    it('should return cp949 for ko-KR locale', () => {
      setLocaleForTesting('ko-KR');
      setWindowsOemCodePageForTesting(null);
      expect(getWindowsOemCodePage()).toBe('cp949');
    });

    it('should return cp866 for ru-RU locale', () => {
      setLocaleForTesting('ru-RU');
      setWindowsOemCodePageForTesting(null);
      expect(getWindowsOemCodePage()).toBe('cp866');
    });

    it('should cache the code page', () => {
      setWindowsOemCodePageForTesting('cp936');
      expect(getWindowsOemCodePage()).toBe('cp936');

      // Even if we change locale, cached value should persist
      setLocaleForTesting('ja-JP');
      expect(getWindowsOemCodePage()).toBe('cp936');
    });
  });
});
