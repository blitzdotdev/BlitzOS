// Vendored two-word name generator. The managed upload set allows only
// relative imports in core/, so this cannot come from an npm package.
const ADJECTIVES: readonly [string, ...string[]] = [
  "amber", "bold", "brave", "breezy", "bright", "calm", "clever", "coral",
  "cosmic", "crimson", "eager", "fancy", "frosty", "gentle", "golden", "happy",
  "indigo", "ivory", "jade", "jolly", "keen", "lively", "lunar", "merry",
  "misty", "mossy", "noble", "olive", "pearl", "proud", "quick", "quiet",
  "ruby", "sandy", "scarlet", "sharp", "silver", "solar", "stormy", "sunny",
  "swift", "teal", "tidy", "violet", "witty", "zesty",
];

const ANIMALS: readonly [string, ...string[]] = [
  "badger", "bison", "camel", "crane", "dingo", "dove", "elk", "falcon",
  "ferret", "finch", "fox", "gecko", "hare", "heron", "ibis", "jackal",
  "koala", "lemur", "lynx", "marten", "mink", "mole", "moose", "newt",
  "ocelot", "osprey", "otter", "owl", "panda", "puffin", "puma", "quail",
  "rabbit", "raven", "sable", "seal", "stoat", "swan", "tiger", "toucan",
  "vole", "walrus", "weasel", "wombat", "wren", "yak", "zebra",
];

function pick(words: readonly [string, ...string[]]): string {
  return words[Math.floor(Math.random() * words.length)] ?? words[0];
}

export function randomWorkspaceName(): string {
  return `${pick(ADJECTIVES)}-${pick(ANIMALS)}`;
}
