export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

/** `JSON.parse` for code that then walks the result.
 *
 * `JSON.parse` is typed `any`, which silently disables every check downstream.
 * This narrows it to the one thing it can actually produce, so a caller branches
 * on a domain value instead of on `typeof` over `unknown`. Returns `null` for
 * input that is not JSON at all — indistinguishable from a literal `null`
 * document, which no caller here sends. */
export function parseJson(text: string): JsonValue {
  try {
    // SAFETY: `JSON.parse` returns exactly the JSON data model, which is what
    // `JsonValue` describes; the assertion replaces its `any` with that.
    return JSON.parse(text) as JsonValue;
  } catch {
    return null;
  }
}

/** A JSON object, as opposed to an array, a scalar or `null`. */
export function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonArray(value: JsonValue): value is JsonValue[] {
  return Array.isArray(value);
}

export function isJsonString(value: JsonValue): value is string {
  return typeof value === "string";
}

export function isJsonNumber(value: JsonValue): value is number {
  return typeof value === "number";
}
