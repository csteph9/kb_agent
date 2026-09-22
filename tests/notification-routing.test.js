import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseUserAliases,
  resolveRecipientPrefix,
  validateRecipientDirectory
} from '../notification-routing.js';

const allowed = new Set([101, 202]);
const users = new Map([[101, 'Alice'], [202, 'Bob Smith']]);
const aliases = parseUserAliases('wife:101, husband:202', allowed);

test('parses aliases only for allowed users', () => {
  assert.equal(aliases.get('wife'), 101);
  assert.throws(
    () => parseUserAliases('friend:303', allowed),
    /unauthorized user ID/
  );
  assert.throws(
    () => parseUserAliases('household:101', allowed),
    /is reserved/
  );
});

test('rejects ambiguous names and aliases', () => {
  assert.throws(
    () => validateRecipientDirectory(
      users,
      new Map([['alice', 202]])
    ),
    /is ambiguous/
  );
  assert.throws(
    () => validateRecipientDirectory(
      new Map([[101, 'Alex'], [202, 'alex']]),
      new Map()
    ),
    /is ambiguous/
  );
});

test('resolves me, configured names, aliases, and multi-word names', () => {
  assert.deepEqual(
    resolveRecipientPrefix('me call the dentist', 101, users, aliases),
    { userId: 101, name: 'Alice', household: false, body: 'call the dentist' }
  );
  assert.equal(
    resolveRecipientPrefix('wife: dinner is at 6', 202, users, aliases).userId,
    101
  );
  assert.equal(
    resolveRecipientPrefix('my wife dinner is at 6', 202, users, aliases).userId,
    101
  );
  assert.deepEqual(
    resolveRecipientPrefix('Bob Smith bring a coat', 101, users, aliases),
    { userId: 202, name: 'Bob Smith', household: false, body: 'bring a coat' }
  );
});

test('household targets are opt-in and unknown recipients do not resolve', () => {
  assert.equal(
    resolveRecipientPrefix('household test', 101, users, aliases),
    null
  );
  assert.deepEqual(
    resolveRecipientPrefix(
      'household test',
      101,
      users,
      aliases,
      { allowHousehold: true }
    ),
    { userId: null, name: 'Household', household: true, body: 'test' }
  );
  assert.equal(
    resolveRecipientPrefix('Charlie test', 101, users, aliases),
    null
  );
});
