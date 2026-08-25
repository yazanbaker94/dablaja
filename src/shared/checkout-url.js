const STRIPE_CHECKOUT_HOST = 'checkout.stripe.com';

export function normalizeStripeCheckoutUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.hostname !== STRIPE_CHECKOUT_HOST) return null;
    if (url.username || url.password || url.port) return null;
    return url.toString();
  } catch {
    return null;
  }
}
