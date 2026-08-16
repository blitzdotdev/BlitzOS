'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const os = require('node:os');
const {
  buildPhoneHomeFailurePayload,
  buildPhoneHomePayload,
  parsePhoneHomeResponse,
  storePhoneHomeResponse,
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

test('guest stores new webapp identity fields without changing the box credential contract', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blitz-enroll-test-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const response = fixture('responses/valid/success.json').body;

  storePhoneHomeResponse(parsePhoneHomeResponse(response), directory);

  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(path.join(directory, 'box-credential.json'), 'utf8')),
    {
      box_id: response.box_id,
      access_token: response.access_token,
      refresh_token: response.refresh_token,
    },
  );
  assert.equal(fs.readFileSync(path.join(directory, 'webapp-token'), 'utf8'), `${response.webapp_token}\n`);
  assert.equal(fs.readFileSync(path.join(directory, 'workspace-id'), 'utf8'), `${response.workspace_id}\n`);
  assert.equal(fs.statSync(path.join(directory, 'webapp-token')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(directory, 'workspace-id')).mode & 0o777, 0o600);
});

test('legacy phone-home response leaves webapp identity files absent', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blitz-enroll-legacy-test-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));

  storePhoneHomeResponse(
    parsePhoneHomeResponse(fixture('responses/valid/legacy-without-webapp-token.json').body),
    directory,
  );

  assert.equal(fs.existsSync(path.join(directory, 'webapp-token')), false);
  assert.equal(fs.existsSync(path.join(directory, 'workspace-id')), false);
});
