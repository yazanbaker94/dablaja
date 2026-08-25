// Regression guard: payment messages (PLUS_START_CHECKOUT / PLUS_RECOVER_LICENSE
// / PLUS_POLL_LICENSE) start with "PLUS_" but must be handled INSIDE the
// service worker (chrome.tabs + cross-origin fetch), not delegated to the
// Plus draft handler. When this ordering broke, every upgrade button silently
// fell back to the static buy.stripe.com link that bypasses install binding.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile('src/service-worker.js', 'utf8');

test('worker-handled PLUS_ types are routed before generic PLUS_ delegation', () => {
  const routerIndex = source.indexOf('WORKER_HANDLED_PLUS_TYPES.has(message.type)');
  const delegateIndex = source.indexOf("startsWith('PLUS_')");
  assert.ok(routerIndex > -1, 'router set must exist');
  assert.ok(delegateIndex > -1, 'generic PLUS_ delegation must exist');
  assert.ok(
    routerIndex < delegateIndex,
    'PLUS_START_CHECKOUT/RECOVER/POLL must be intercepted BEFORE startsWith(PLUS_) delegation'
  );
});

test('all payment message types are listed in the worker router', () => {
  for (const type of ['PLUS_START_CHECKOUT', 'PLUS_RECOVER_LICENSE', 'PLUS_ROTATE_RECOVERY', 'PLUS_POLL_LICENSE']) {
    assert.ok(
      source.includes(`'${type}'`),
      `${type} missing from WORKER_HANDLED_PLUS_TYPES`
    );
  }
});

test('checkout handler is wired exactly once (no duplicated dead switch cases)', () => {
  const occurrences = source.split('return startCheckout()').length - 1;
  assert.equal(occurrences, 1, 'startCheckout() must be dispatched from exactly one place');
});

test('no static Stripe fallback remains in any UI surface', async () => {
  // The static buy.stripe.com link bypassed install binding entirely; every
  // failure path must surface a real error instead.
  for (const file of ['src/popup/popup.js', 'src/library/library.js', 'src/stats/stats.js']) {
    const text = await readFile(file, 'utf8');
    assert.ok(!text.includes('buy.stripe.com'), `${file} still contains a static Stripe link`);
    assert.ok(!text.includes('STRIPE_PAYMENT_LINK'), `${file} still references STRIPE_PAYMENT_LINK`);
    if (text.includes("'PLUS_START_CHECKOUT'") || text.includes('PLUS_START_CHECKOUT')) continue;
  }
});
