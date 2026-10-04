import test from 'node:test';
import assert from 'node:assert/strict';
import { validateApiKey } from '../src/shared/key-validation.js';

const VALID_KEY = 'AIza' + 'a'.repeat(35);

test('well-formed key is accepted without a separate consent gate', () => {
  const result = validateApiKey(VALID_KEY);
  assert.equal(result.ok, true);
  assert.equal(result.apiKey, VALID_KEY);
});

test('malformed keys are rejected', () => {
  assert.equal(validateApiKey('short').ok, false);
  assert.equal(validateApiKey('x'.repeat(300)).ok, false);
  assert.equal(validateApiKey().ok, false);
});

test('surrounding whitespace is trimmed from the key', () => {
  const result = validateApiKey(`  ${VALID_KEY}  `);
  assert.equal(result.ok, true);
  assert.equal(result.apiKey, VALID_KEY);
});
