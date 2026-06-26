// blitzos-telemetry — schema for the BlitzOS session-replay backend (plans/blitzos-telemetry.md).
// Deployed to the blitz.dev project `blitzos-telemetry` via scripts/telemetry-push.mjs.
//
// Three tables, all CRUD rules DENIED (no rules extension = deny-all): every read/write goes
// through worker.ts routes gated by the INGEST_KEY secret. R2 objects live under telemetry/<sid>/.
// Counter columns on sessions are maintained by the worker at ingest time so the dashboard's
// aggregate view never has to touch R2 or unzip segments.
import { sql, tableField, baseFields, createdTrigger, updatedTrigger } from 'teenybase'

const sessions = {
  name: 'sessions',
  fields: [
    ...baseFields,
    tableField('sid', 'text', 'text', { notNull: true, unique: true }),
    tableField('device', 'text', 'text', {}),
    tableField('version', 'text', 'text', {}),
    tableField('branch', 'text', 'text', {}),
    tableField('run', 'integer', 'integer', { default: sql`0` }),
    tableField('platform', 'text', 'text', {}),
    tableField('meta', 'json', 'text', {}),
    // running aggregates, bumped per ingested segment/frame
    tableField('events', 'integer', 'integer', { default: sql`0` }),
    tableField('errors', 'integer', 'integer', { default: sql`0` }),
    tableField('tools', 'integer', 'integer', { default: sql`0` }),
    tableField('frames', 'integer', 'integer', { default: sql`0` }),
    tableField('segs', 'integer', 'integer', { default: sql`0` }),
    tableField('t0', 'integer', 'integer', { default: sql`0` }),
    tableField('t1', 'integer', 'integer', { default: sql`0` })
  ],
  indexes: [{ fields: ['sid'], unique: true }],
  extensions: [],
  triggers: [createdTrigger, updatedTrigger]
}

const segments = {
  name: 'segments',
  fields: [
    ...baseFields,
    tableField('sid', 'text', 'text', { notNull: true }),
    tableField('seq', 'integer', 'integer', { default: sql`0` }),
    tableField('t0', 'integer', 'integer', { default: sql`0` }),
    tableField('t1', 'integer', 'integer', { default: sql`0` }),
    tableField('lines', 'integer', 'integer', { default: sql`0` }),
    tableField('errn', 'integer', 'integer', { default: sql`0` }),
    tableField('counts', 'json', 'text', {}),
    tableField('errs', 'json', 'text', {}),
    tableField('key', 'text', 'text', {}) // R2 object key (gzipped JSONL)
  ],
  indexes: [{ fields: ['sid'] }],
  extensions: [],
  triggers: [createdTrigger, updatedTrigger]
}

const frames = {
  name: 'frames',
  fields: [
    ...baseFields,
    tableField('sid', 'text', 'text', { notNull: true }),
    tableField('t', 'integer', 'integer', { default: sql`0` }),
    tableField('key', 'text', 'text', {}) // R2 object key (jpeg)
  ],
  indexes: [{ fields: ['sid'] }],
  extensions: [],
  triggers: [createdTrigger, updatedTrigger]
}

const activitySessions = {
  name: 'activity_sessions',
  fields: [
    ...baseFields,
    tableField('sid', 'text', 'text', { notNull: true, unique: true }),
    tableField('install', 'text', 'text', {}),
    tableField('version', 'text', 'text', {}),
    tableField('branch', 'text', 'text', {}),
    tableField('run', 'integer', 'integer', { default: sql`0` }),
    tableField('channel', 'text', 'text', {}),
    tableField('platform', 'text', 'text', {}),
    tableField('events', 'integer', 'integer', { default: sql`0` }),
    tableField('t0', 'integer', 'integer', { default: sql`0` }),
    tableField('t1', 'integer', 'integer', { default: sql`0` })
  ],
  indexes: [{ fields: ['sid'], unique: true }],
  extensions: [],
  triggers: [createdTrigger, updatedTrigger]
}

const activityEvents = {
  name: 'activity_events',
  fields: [
    ...baseFields,
    tableField('sid', 'text', 'text', { notNull: true }),
    tableField('t', 'integer', 'integer', { default: sql`0` }),
    tableField('name', 'text', 'text', { notNull: true }),
    tableField('props', 'json', 'text', {})
  ],
  indexes: [{ fields: ['sid'] }, { fields: ['name'] }],
  extensions: [],
  triggers: [createdTrigger, updatedTrigger]
}

export default {
  appName: 'blitzos-telemetry',
  appUrl: 'https://blitzos-telemetry.app.blitz.dev',
  jwtSecret: '$JWT_SECRET_MAIN',
  tables: [sessions, segments, frames, activitySessions, activityEvents]
}
