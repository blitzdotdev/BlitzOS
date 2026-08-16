'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  buildPhoneHomeFailurePayload,
  buildPhoneHomePayload,
  parsePhoneHomeResponse,
} = require('./blitz-microvm-enroll.js');

const fixturesDirectory = path.resolve(
  __dirname,
  '../../schema/fixtures/phone-home',
);

function fixture(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(fixturesDirectory, relativePath), 'utf8'));
}

function fixtureNames(relativeDirectory) {
  return fs.readdirSync(path.join(fixturesDirectory, relativeDirectory))
    .filter((name) => name.endsWith('.json'))
    .sort();
}

test('guest emits only canonical phone-home request keys', () => {
  const success = fixture('requests/valid/json-success.json');
  const failure = fixture('requests/valid/json-failure.json');
  assert.deepStrictEqual(
    buildPhoneHomePayload(Object.values(success.body)),
    success.body,
  );
  assert.deepStrictEqual(
    buildPhoneHomeFailurePayload(failure.body.bootstrap_error),
    failure.body,
  );
  assert.deepStrictEqual(
    Object.keys(buildPhoneHomePayload(Object.values(success.body))),
    success.expect.canonicalKeys,
  );
  assert.deepStrictEqual(
    Object.keys(buildPhoneHomeFailurePayload(failure.body.bootstrap_error)),
    failure.expect.canonicalKeys,
  );
});

test('guest accepts and rejects every shared phone-home response fixture', () => {
  const validNames = fixtureNames('responses/valid');
  const invalidNames = fixtureNames('responses/invalid');
  for (const name of validNames) {
    const descriptor = fixture(`responses/valid/${name}`);
    assert.deepStrictEqual(parsePhoneHomeResponse(descriptor.body), descriptor.body);
  }
  for (const name of invalidNames) {
    const descriptor = fixture(`responses/invalid/${name}`);
    assert.throws(() => parsePhoneHomeResponse(descriptor.body));
  }
  console.log(
    `phone-home guest response conformance: ${validNames.length} valid + ${invalidNames.length} invalid fixtures`,
  );
});
