import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const popup = await readFile('src/popup/popup.js', 'utf8');
const worker = await readFile('src/service-worker.js', 'utf8');
const sidepanel = await readFile('src/sidepanel/sidepanel.js', 'utf8');
const sidepanelHtml = await readFile('src/sidepanel/sidepanel.html', 'utf8');

test('starting dubbing also requests the persistent captions side panel', () => {
  assert.match(popup, /chrome\.sidePanel\?\.open|chrome\.sidePanel\.open/);
  assert.match(popup, /openCaptionPanel\(capture\.tabId\)/);
  assert.match(popup, /تعذر فتح النصوص تلقائياً/);
});

test('the worker start command is dispatched before panel opening can close the popup', () => {
  const startAt = popup.indexOf("const capture = await activeTabStartOptions();");
  const startBlock = popup.slice(startAt, popup.indexOf("if (response?.state) currentState = response.state;", startAt));
  assert.ok(startBlock.includes("request({ type: 'START_SESSION', ...capture })"));
  assert.ok(startBlock.includes('openCaptionPanel(capture.tabId)'));
  assert.ok(
    startBlock.indexOf("request({ type: 'START_SESSION', ...capture })")
      < startBlock.indexOf('openCaptionPanel(capture.tabId)'),
    'START_SESSION must be sent before sidePanel.open can dismiss the popup'
  );
});

test('the service worker—not the popup—owns tabCapture stream ID creation', () => {
  assert.ok(!popup.includes('chrome.tabCapture.getMediaStreamId'), 'popup must not create the capture stream ID');
  assert.match(worker, /chrome\.tabCapture\.getMediaStreamId\(\{ targetTabId: tab\.id \}\)/);
});

test('start failures remain actionable if opening the side panel closes the popup', () => {
  assert.ok(sidepanelHtml.includes('id="panelMessage"'));
  assert.match(sidepanel, /panelMessage\.textContent/);
  assert.match(sidepanel, /STATUS\.ERROR/);
  assert.match(sidepanel, /STATUS\.RATE_LIMITED/);
});
