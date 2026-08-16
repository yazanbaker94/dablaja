import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GEMINI_CONSENT_TEXT_AR,
  GEMINI_CONSENT_TEXT_EN,
  requiresFreshConsent,
  validateKeySave
} from '../src/shared/key-consent.js';

const VALID_KEY = 'AIza' + 'a'.repeat(35);

test('saving a key without explicit consent is refused', () => {
  const result = validateKeySave({ apiKey: VALID_KEY, consent: false });
  assert.equal(result.ok, false);
  assert.match(result.error, /الموافقة/);
  assert.equal(validateKeySave({ apiKey: VALID_KEY }).ok, false);
  assert.equal(validateKeySave({ apiKey: VALID_KEY, consent: 'yes' }).ok, false);
});

test('saving a key requires an actual true consent flag', () => {
  const result = validateKeySave({ apiKey: VALID_KEY, consent: true });
  assert.equal(result.ok, true);
  assert.equal(result.apiKey, VALID_KEY);
});

test('malformed keys are rejected regardless of consent', () => {
  assert.equal(validateKeySave({ apiKey: 'short', consent: true }).ok, false);
  assert.equal(validateKeySave({ apiKey: 'x'.repeat(300), consent: true }).ok, false);
  assert.equal(validateKeySave({ consent: true }).ok, false);
});

test('consent disclosure states local-only retention and Plus save exception', () => {
  assert.match(GEMINI_CONSENT_TEXT_AR, /أوافق على إرسال صوت التبويب/);
  assert.match(GEMINI_CONSENT_TEXT_AR, /Google Gemini/);
  assert.match(GEMINI_CONSENT_TEXT_AR, /Plus/);
  assert.match(GEMINI_CONSENT_TEXT_EN, /directly to Google Gemini/);
});

test('viewing a saved masked key does not re-require consent', () => {
  assert.equal(requiresFreshConsent({ keyEdited: false, hasSavedKey: true }), false);
  assert.equal(requiresFreshConsent({ keyEdited: true, hasSavedKey: true }), true);
  assert.equal(requiresFreshConsent({ keyEdited: false, hasSavedKey: false }), true);
});
