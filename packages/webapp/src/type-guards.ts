export function isString<Value>(value: Value): value is Value & string {
  return typeof value === 'string';
}

export function isNumber<Value>(value: Value): value is Value & number {
  return typeof value === 'number';
}

export function isBoolean<Value>(value: Value): value is Value & boolean {
  return typeof value === 'boolean';
}

export function hasObjectType<Value>(value: Value): value is Value & (object | null) {
  return typeof value === 'object';
}

export function asJsonObject<Value>(value: Value): JsonObject | null {
  if (!value || !hasObjectType(value) || Array.isArray(value)) return null;
  // SAFETY: The checks above establish a non-null, non-array object with JSON properties.
  return value as JsonObject;
}

export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}
