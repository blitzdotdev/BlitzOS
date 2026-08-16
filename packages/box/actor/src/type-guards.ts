export function isString<Value>(value: Value): value is Value & string {
  return typeof value === "string";
}

export function isNumber<Value>(value: Value): value is Value & number {
  return typeof value === "number";
}

export function hasObjectType<Value>(value: Value): value is Value & (object | null) {
  return typeof value === "object";
}
