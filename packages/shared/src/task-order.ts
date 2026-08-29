/**
 * Fractional index ordering for tasks.
 *
 * Manual reordering must write only the moved task's key, never renumber its
 * siblings: order keys live in per-task metadata, so a renumbering pass would
 * turn one drag into N metadata writes and would lose races against concurrent
 * edits. Keys are compared as plain strings.
 *
 * Keys use a strictly ascending digit alphabet and never end in the lowest
 * digit, which keeps a midpoint available between any two neighbours.
 */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const FIRST_DIGIT = DIGITS.charAt(0);
const LAST_DIGIT = DIGITS.charAt(DIGITS.length - 1);

export const TASK_ORDER_MIN_KEY = DIGITS.charAt(1);

const digitIndex = (digit: string | undefined): number => {
  const index = digit === undefined ? -1 : DIGITS.indexOf(digit);
  if (index < 0) {
    throw new Error(`invalid order key digit: ${digit}`);
  }
  return index;
};

const digitAt = (value: string, index: number): string => {
  const digit = value[index];
  if (digit === undefined) {
    throw new Error(`order key index out of range: ${value}[${index}]`);
  }
  return digit;
};

const assertValidKey = (key: string, label: string): void => {
  if (key.length === 0) {
    throw new Error(`${label} order key must not be empty`);
  }
  if (key.endsWith(FIRST_DIGIT)) {
    throw new Error(`${label} order key must not end with '${FIRST_DIGIT}': ${key}`);
  }
  for (const digit of key) {
    digitIndex(digit);
  }
};

/**
 * Smallest string strictly between `before` and `after`, where `null` means
 * unbounded on that side.
 */
const midpoint = (before: string, after: string | null): string => {
  if (after !== null && before >= after) {
    throw new Error(`order keys out of sequence: ${before} >= ${after}`);
  }

  if (after !== null) {
    let common = 0;
    while ((before[common] ?? FIRST_DIGIT) === after[common]) {
      common += 1;
    }
    if (common > 0) {
      return after.slice(0, common) + midpoint(before.slice(common), after.slice(common));
    }
  }

  const beforeDigit = before.length > 0 ? digitIndex(before[0]) : 0;
  const afterDigit = after !== null ? digitIndex(after[0]) : DIGITS.length;

  if (afterDigit - beforeDigit > 1) {
    return digitAt(DIGITS, Math.round((beforeDigit + afterDigit) / 2));
  }

  if (after !== null && after.length > 1) {
    return after.slice(0, 1);
  }

  // Digits are adjacent: keep `before`'s first digit and recurse into its tail.
  return digitAt(DIGITS, beforeDigit) + midpoint(before.slice(1), null);
};

export type TaskOrderRandom = () => number;

const appendJitter = (
  key: string,
  after: string | null,
  random: TaskOrderRandom | undefined
): string => {
  if (!random) {
    return key;
  }
  const value = random();
  if (!Number.isFinite(value)) {
    return key;
  }

  // `midpoint` may return a strict PREFIX of `after` (e.g. between "5" and
  // "6X" it returns "6"). Appending a digit to a prefix can jump past the right
  // neighbour — "6" + "t" sorts after "6X" — so the jitter digit is capped
  // below the neighbour's next digit. When there is no room (the neighbour's
  // next digit is the lowest one) the un-jittered key is already correct, and a
  // collision there is still resolved deterministically by `compareTaskOrder`.
  let highest = DIGITS.length - 1;
  if (after !== null && after.length > key.length && after.startsWith(key)) {
    highest = digitIndex(digitAt(after, key.length)) - 1;
  }
  if (highest < 1) {
    return key;
  }

  const clamped = Math.min(Math.max(value, 0), 0.999999);
  // Skip the lowest digit so the jittered key keeps the "no trailing zero"
  // invariant.
  const index = 1 + Math.floor(clamped * highest);
  return key + digitAt(DIGITS, Math.min(index, highest));
};

/**
 * Order key strictly between two neighbours. Pass `null` for the start or end
 * of the list. `random` adds a trailing digit so two clients inserting at the
 * same position do not produce the same key.
 */
export const generateTaskOrderKeyBetween = (
  before: string | null,
  after: string | null,
  random?: TaskOrderRandom
): string => {
  if (before !== null) {
    assertValidKey(before, 'before');
  }
  if (after !== null) {
    assertValidKey(after, 'after');
  }
  if (before !== null && after !== null && before >= after) {
    throw new Error(`order keys out of sequence: ${before} >= ${after}`);
  }

  if (before === null && after === null) {
    return appendJitter(TASK_ORDER_MIN_KEY, null, random);
  }

  if (before === null && after !== null) {
    return appendJitter(midpoint('', after), after, random);
  }

  if (before !== null && after === null) {
    // Cheap append: bump the last digit when possible, otherwise extend.
    const head = before.slice(0, -1);
    const tail = digitAt(before, before.length - 1);
    if (tail !== LAST_DIGIT) {
      return appendJitter(head + digitAt(DIGITS, digitIndex(tail) + 1), null, random);
    }
    return appendJitter(`${before}${digitAt(DIGITS, 1)}`, null, random);
  }

  return appendJitter(midpoint(before as string, after as string), after as string, random);
};

/** Order key that sorts after every existing key. */
export const generateTaskOrderKeyAtEnd = (
  existingKeys: readonly string[],
  random?: TaskOrderRandom
): string => {
  let max: string | null = null;
  for (const key of existingKeys) {
    if (key.length > 0 && (max === null || key > max)) {
      max = key;
    }
  }
  return generateTaskOrderKeyBetween(max, null, random);
};

/** Order key that sorts before every existing key. */
export const generateTaskOrderKeyAtStart = (
  existingKeys: readonly string[],
  random?: TaskOrderRandom
): string => {
  let min: string | null = null;
  for (const key of existingKeys) {
    if (key.length > 0 && (min === null || key < min)) {
      min = key;
    }
  }
  return generateTaskOrderKeyBetween(null, min, random);
};

/** Stable comparator: order key first, then id, so equal keys never flip. */
export const compareTaskOrder = (
  a: { order: string; id: string },
  b: { order: string; id: string }
): number => {
  if (a.order !== b.order) {
    return a.order < b.order ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};
