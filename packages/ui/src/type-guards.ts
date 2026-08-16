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

export function isDefined<Value>(value: Value): value is Exclude<Value, undefined> {
  return typeof value !== 'undefined';
}
