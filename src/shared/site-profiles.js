// Per-site original/dubbed volume profiles — local, opt-in, origin-only.
// Full URLs are never stored; only the hostname (optionally with port),
// normalized by the ONE shared normalizer used everywhere.

import { normalizeOrigin } from './normalize-origin.js';

export const SITE_PROFILE_LIMITS = Object.freeze({
  MAX_PROFILES: 50
});

// Single normalization entry point for profiles and session metadata alike.
export function normalizeProfileOrigin(value) {
  return normalizeOrigin(value);
}

function safeVolume(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.min(1.5, numeric));
}

export function canAddProfile(profiles, origin, limit = SITE_PROFILE_LIMITS.MAX_PROFILES) {
  const key = normalizeProfileOrigin(origin);
  if (!key) return false;
  const existing = Array.isArray(profiles) ? profiles : [];
  const exists = existing.some((p) => p.origin === key);
  if (exists) return true;
  return existing.length < (Number.isFinite(limit) ? limit : SITE_PROFILE_LIMITS.MAX_PROFILES);
}

export function upsertProfile(profiles, { origin, originalVolume, dubbedVolume } = {}, limit = SITE_PROFILE_LIMITS.MAX_PROFILES) {
  const key = normalizeProfileOrigin(origin);
  if (!key) return Array.isArray(profiles) ? [...profiles] : [];
  // Explicit null/undefined means "keep the stored level" — safeVolume(null)
  // would coerce to 0 and silently zero the untouched channel.
  const original = originalVolume == null ? null : safeVolume(originalVolume);
  const dubbed = dubbedVolume == null ? null : safeVolume(dubbedVolume);
  if (original == null && dubbed == null) return Array.isArray(profiles) ? [...profiles] : [];
  const existing = Array.isArray(profiles) ? [...profiles] : [];
  const previous = existing.find((profile) => profile.origin === key);
  const record = {
    origin: key,
    originalVolume: original ?? previous?.originalVolume ?? null,
    dubbedVolume: dubbed ?? previous?.dubbedVolume ?? null,
    updatedAt: Date.now()
  };
  if (previous) {
    return existing.map((profile) => (profile.origin === key ? record : profile));
  }
  const max = Number.isFinite(limit) ? limit : SITE_PROFILE_LIMITS.MAX_PROFILES;
  const next = [...existing, record];
  if (next.length > max) {
    // Records are appended chronologically, so evict from the front; this
    // stays correct even when Date.now() ties within the same millisecond.
    next.splice(0, next.length - max);
  }
  return next;
}

// Volume profile to apply when a new session starts on this origin.
export function profileForOrigin(profiles, origin) {
  const key = normalizeProfileOrigin(origin);
  if (!key || !Array.isArray(profiles)) return null;
  return profiles.find((profile) => profile.origin === key) || null;
}

export function removeProfile(profiles, origin) {
  const key = normalizeProfileOrigin(origin);
  if (!key || !Array.isArray(profiles)) return Array.isArray(profiles) ? [...profiles] : [];
  return profiles.filter((profile) => profile.origin !== key);
}

export function countProfiles(profiles) {
  return Array.isArray(profiles) ? profiles.length : 0;
}
