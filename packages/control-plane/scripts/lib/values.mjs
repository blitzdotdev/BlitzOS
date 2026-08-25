// Decoders for values that arrive from outside the process: parsed TOML, and
// JSON printed by wrangler.
//
// Both questions below are asked without `typeof`, and not to satisfy a lint
// rule. `typeof x === "object"` narrows a representation and answers nothing:
// it is true of null, of arrays, and of every Date. These ask what a value IS.

/**
 * True for a TOML table, and for nothing else.
 *
 * A table is a plain object. Arrays, dates, strings and numbers each carry a
 * different prototype, so the prototype separates them in one comparison —
 * including the two cases a `typeof` test gets wrong, null and arrays.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isTable(value) {
  if (value === null || value === undefined) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * True for a non-empty primitive string.
 *
 * Only a primitive string is equal to its own `String()` form: a number, a
 * boolean, null, and even a boxed `new String("x")` all fail the comparison.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isNonEmptyString(value) {
  return String(value) === value && value !== "";
}
