export const PASSWORD_MIN_LENGTH = 8;

export type PasswordValidationFailure =
  | { ok: false; reason: 'too-short'; minLength: number }
  | { ok: false; reason: 'needs-letter-and-digit' };

export type PasswordValidationResult = { ok: true } | PasswordValidationFailure;

const HAS_LETTER = /[A-Za-z]/;
const HAS_DIGIT = /[0-9]/;

/**
 * Shared rules used when setting a password (sign-up, reset).
 *
 * Why letters + digits: matches the most common "complex enough" baseline without
 * requiring symbols (rejected: symbol requirement hurts password-manager UX more
 * than it raises entropy at this length). Sign-in flows must NOT call this since
 * existing passwords may have been created under older rules.
 */
export function validateNewPassword(password: string): PasswordValidationResult {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return { ok: false, reason: 'too-short', minLength: PASSWORD_MIN_LENGTH };
  }
  if (!HAS_LETTER.test(password) || !HAS_DIGIT.test(password)) {
    return { ok: false, reason: 'needs-letter-and-digit' };
  }
  return { ok: true };
}
