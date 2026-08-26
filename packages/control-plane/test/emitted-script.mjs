import assert from "node:assert/strict";

/** One heredoc body out of an emitted bootstrap script, by its terminator
 * marker. The heredoc-start line may carry a redirect after the marker
 * (`<<'RESULT_WRITER' >"$result_tmp"`), so only the terminator is anchored.
 *
 * Both host-side suites read the emitted bytes this way: the contract corpus
 * in box-update-conformance.test.mjs and the behaviour run in
 * box-update-host.test.mjs. One reader, one convention. */
export function embeddedSection(script, marker) {
  const match = script.match(
    new RegExp(String.raw`<<'${marker}'[^\n]*\n(?<body>[\s\S]*?)\n${marker}\n`, "u"),
  );
  assert.ok(match?.groups?.body, `embedded ${marker} section was not found`);
  return match.groups.body;
}
