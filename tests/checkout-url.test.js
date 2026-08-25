import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeStripeCheckoutUrl } from '../src/shared/checkout-url.js';

test('accepts only credential-free HTTPS Stripe Checkout URLs', () => {
  assert.equal(
    normalizeStripeCheckoutUrl('https://checkout.stripe.com/c/pay/cs_test_123#fidkdWxOYHwnPyd1blpxYHZxWjA0'),
    'https://checkout.stripe.com/c/pay/cs_test_123#fidkdWxOYHwnPyd1blpxYHZxWjA0'
  );
  for (const unsafe of [
    'http://checkout.stripe.com/c/pay/cs_test',
    'https://checkout.stripe.com.evil.example/c/pay/cs_test',
    'https://stripe.example/c/pay/cs_test',
    'https://user:pass@checkout.stripe.com/c/pay/cs_test',
    'https://checkout.stripe.com:444/c/pay/cs_test',
    'javascript:alert(1)',
    '',
    null
  ]) {
    assert.equal(normalizeStripeCheckoutUrl(unsafe), null, String(unsafe));
  }
});
