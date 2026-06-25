// blitzscript — a tiny, self-contained JSON-Schema validator + stub generator.
//
// Covers ONLY the subset the claude_workflows corpus actually uses (verified by grep over
// examples/claude_workflows/*.js): `type` (object/array/string/number/integer/boolean/null),
// `properties`, `required`, `items`, `enum`, `additionalProperties:false`. We deliberately do NOT add
// ajv as a direct dependency (it is only transitively present); this subset is ~100 lines and matches
// the shapes the leaves are asked to return.
//
//   validate(value, schema) -> { ok: boolean, errors: string[] }
//   stubFromSchema(schema)  -> a representative value (for `blitz check` dry-run, so real field access /
//                              .filter(Boolean) / .map() over the result runs without a real LLM)

/** Validate `value` against `schema`. Returns { ok, errors }. A null/undefined schema accepts anything. */
export function validate(value, schema) {
  const errors = []
  _validate(value, schema, '$', errors)
  return { ok: errors.length === 0, errors }
}

function _typeOf(v) {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v // 'object' | 'string' | 'number' | 'boolean' | 'undefined' | 'function'
}

// JSON-Schema's type names vs JS typeof: integer is a number with no fraction; number accepts both.
function _matchesType(v, t) {
  const jt = _typeOf(v)
  if (t === 'integer') return jt === 'number' && Number.isInteger(v)
  if (t === 'number') return jt === 'number' && Number.isFinite(v)
  if (t === 'object') return jt === 'object'
  if (t === 'array') return jt === 'array'
  if (t === 'string') return jt === 'string'
  if (t === 'boolean') return jt === 'boolean'
  if (t === 'null') return jt === 'null'
  return true // unknown type keyword -> don't constrain
}

function _validate(value, schema, path, errors) {
  if (!schema || typeof schema !== 'object') return // no/loose schema -> accept

  // type (a single string or an array of allowed types)
  if (schema.type != null) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some((t) => _matchesType(value, t))) {
      errors.push(`${path}: expected type ${types.join('|')}, got ${_typeOf(value)}`)
      return // a wrong base type makes deeper checks meaningless
    }
  }

  // enum
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.some((e) => _deepEqual(e, value))) {
      errors.push(`${path}: value ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`)
    }
  }

  const t = _typeOf(value)

  // object: required + properties + additionalProperties:false
  if (t === 'object' && (schema.properties || schema.required || schema.additionalProperties === false)) {
    const props = schema.properties || {}
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!(key in value) || value[key] === undefined) errors.push(`${path}.${key}: required property missing`)
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (key in value && value[key] !== undefined) _validate(value[key], sub, `${path}.${key}`, errors)
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) errors.push(`${path}.${key}: additional property not allowed`)
      }
    }
  }

  // array: items (a single sub-schema applied to every element)
  if (t === 'array' && schema.items) {
    for (let k = 0; k < value.length; k++) _validate(value[k], schema.items, `${path}[${k}]`, errors)
  }
}

function _deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a && b && typeof a === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b)
    if (ka.length !== kb.length) return false
    return ka.every((k) => _deepEqual(a[k], b[k]))
  }
  return false
}

/**
 * A representative value for `schema` (dry-run). For an enum, the first value; for objects, every
 * REQUIRED property (plus any declared property) recursed; for arrays, ONE representative element so a
 * `.map()`/`.filter()` over the result exercises real control flow. Cheap + deterministic.
 */
export function stubFromSchema(schema) {
  if (!schema || typeof schema !== 'object') return null
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0]

  const types = schema.type == null ? [] : (Array.isArray(schema.type) ? schema.type : [schema.type])
  const type = types[0] || _inferType(schema)

  switch (type) {
    case 'object': {
      const out = {}
      const props = schema.properties || {}
      const required = new Set(Array.isArray(schema.required) ? schema.required : [])
      // include all declared properties (covers required + gives dry-run code real fields to touch).
      for (const [key, sub] of Object.entries(props)) out[key] = stubFromSchema(sub)
      // a required key with no declared sub-schema -> a harmless placeholder.
      for (const key of required) if (!(key in out)) out[key] = null
      return out
    }
    case 'array':
      return schema.items ? [stubFromSchema(schema.items)] : []
    case 'string':
      return ''
    case 'integer':
    case 'number':
      return 0
    case 'boolean':
      return false
    case 'null':
      return null
    default:
      return null
  }
}

// Infer a type when `type` is omitted but structure implies it (properties -> object, items -> array).
function _inferType(schema) {
  if (schema.properties || schema.required || schema.additionalProperties === false) return 'object'
  if (schema.items) return 'array'
  return 'null'
}

export default { validate, stubFromSchema }
