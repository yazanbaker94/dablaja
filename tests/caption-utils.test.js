import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeCaptionText, shouldFinalizeCaption } from '../src/shared/caption-utils.js';

test('caption merger replaces an interim prefix with cumulative text', () => {
  assert.equal(mergeCaptionText('hello', 'hello world'), 'hello world');
  assert.equal(mergeCaptionText('مرحباً', 'مرحباً بالعالم'), 'مرحباً بالعالم');
});

test('caption merger ignores shorter and repeated fragments', () => {
  assert.equal(mergeCaptionText('hello world', 'hello'), 'hello world');
  assert.equal(mergeCaptionText('hello world', 'world'), 'hello world');
});

test('caption merger joins distinct streaming fragments once', () => {
  assert.equal(mergeCaptionText('hello', 'world'), 'hello world');
  assert.equal(mergeCaptionText('مرحبا،', 'يا صديقي'), 'مرحبا، يا صديقي');
});

test('caption finalization honors server signal and sentence punctuation', () => {
  assert.equal(shouldFinalizeCaption('still speaking', false), false);
  assert.equal(shouldFinalizeCaption('done.', false), true);
  assert.equal(shouldFinalizeCaption('تم؟', false), true);
  assert.equal(shouldFinalizeCaption('explicit', true), true);
});
