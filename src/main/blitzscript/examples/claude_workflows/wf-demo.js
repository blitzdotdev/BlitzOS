// wf-demo — a small, fast, visually-rich workflow for the live externalization test. A parallel fan-out of
// four cheap "coiner" leaves, then one "judge" leaf. Watch the live widget: phase 'brainstorm' opens a
// parallel group of 4 (queued -> glowing -> done), then phase 'judge' runs one node. ~15-30s on haiku.
export const meta = { name: 'Name the Island', description: 'brainstorm app names in parallel, then pick the best' }

phase('brainstorm')
const ideas = await parallel([
  () => agent('Invent ONE short, evocative name for a calm focus app. Reply with ONLY the name, nothing else.', { label: 'coiner · evocative', model: 'cheap' }, 'Driftwood'),
  () => agent('Invent ONE playful name for a calm focus app. Reply with ONLY the name, nothing else.', { label: 'coiner · playful', model: 'cheap' }, 'Pebble'),
  () => agent('Invent ONE elegant one-word name for a focus app. Reply with ONLY the name, nothing else.', { label: 'coiner · elegant', model: 'cheap' }, 'Lumen'),
  () => agent('Invent ONE bold, punchy name for a focus app. Reply with ONLY the name, nothing else.', { label: 'coiner · bold', model: 'cheap' }, 'Forge'),
])

phase('judge')
const pick = await agent(
  'From these candidate names pick the single best for a calm focus app and explain in ONE sentence why: ' + JSON.stringify(ideas),
  { label: 'judge', model: 'cheap' },
  'Lumen — it is calm, short, and memorable.'
)

return { ideas, pick }
