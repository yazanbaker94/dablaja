import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SITE_PROFILE_LIMITS,
  canAddProfile,
  countProfiles,
  normalizeProfileOrigin,
  profileForOrigin,
  removeProfile,
  upsertProfile
} from '../src/shared/site-profiles.js';

test('origins normalize to bare hostnames and reject junk', () => {
  assert.equal(normalizeProfileOrigin('https://www.YouTube.COM/watch'), 'www.youtube.com');
  assert.equal(normalizeProfileOrigin('YouTube.com'), 'youtube.com');
  assert.equal(normalizeProfileOrigin('courses.example.com:8443'), 'courses.example.com:8443');
  assert.equal(normalizeProfileOrigin('not a host!!'), '');
  assert.equal(normalizeProfileOrigin(''), '');
  assert.equal(normalizeProfileOrigin('javascript:alert(1)'), '');
});

test('upsertProfile stores volumes per origin and merges partial updates', () => {
  let profiles = [];
  profiles = upsertProfile(profiles, { origin: 'youtube.com', originalVolume: 0.2, dubbedVolume: 1 });
  profiles = upsertProfile(profiles, { origin: 'youtube.com', originalVolume: 0.4 });
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].originalVolume, 0.4);
  assert.equal(profiles[0].dubbedVolume, 1);
  assert.ok(profiles[0].updatedAt > 0);
});

test('upsertProfile clamps volumes and ignores invalid input', () => {
  let profiles = upsertProfile([], { origin: 'youtube.com', originalVolume: 9, dubbedVolume: -3 });
  assert.equal(profiles[0].originalVolume, 1.5);
  assert.equal(profiles[0].dubbedVolume, 0);
  assert.equal(upsertProfile([], { origin: 'bad host' }).length, 0);
  assert.equal(upsertProfile([], { origin: 'youtube.com', originalVolume: 'x', dubbedVolume: 'y' }).length, 0);
});

test('upsertProfile treats explicit null as "keep existing", never zero', () => {
  let profiles = upsertProfile([], { origin: 'youtube.com', originalVolume: 0.2, dubbedVolume: 1.1 });
  profiles = upsertProfile(profiles, { origin: 'youtube.com', originalVolume: 0.4, dubbedVolume: null });
  assert.equal(profiles[0].originalVolume, 0.4);
  assert.equal(profiles[0].dubbedVolume, 1.1, 'explicit null must not coerce to 0');
  profiles = upsertProfile(profiles, { origin: 'youtube.com', originalVolume: null, dubbedVolume: 0.5 });
  assert.equal(profiles[0].originalVolume, 0.4, 'explicit null must not coerce to 0 (reverse)');
  assert.equal(profiles[0].dubbedVolume, 0.5);
  // Both null: nothing changes and no record is created.
  assert.equal(upsertProfile([], { origin: 'youtube.com', originalVolume: null, dubbedVolume: null }).length, 0);
  assert.deepEqual(upsertProfile(profiles, { origin: 'youtube.com', originalVolume: null, dubbedVolume: null }), profiles);
});

test('profile lookup matches by origin exactly', () => {
  const profiles = upsertProfile([], { origin: 'youtube.com', originalVolume: 0.3 });
  assert.equal(profileForOrigin(profiles, 'https://youtube.com/watch?v=1').originalVolume, 0.3);
  assert.equal(profileForOrigin(profiles, 'other.com'), null);
  assert.equal(profileForOrigin(profiles, ''), null);
  assert.equal(profileForOrigin(null, 'youtube.com'), null);
});

test('removeProfile deletes only the targeted origin', () => {
  let profiles = upsertProfile([], { origin: 'a.com', originalVolume: 1 });
  profiles = upsertProfile(profiles, { origin: 'b.com', originalVolume: 1 });
  profiles = removeProfile(profiles, 'https://a.com/x');
  assert.deepEqual(profiles.map((p) => p.origin), ['b.com']);
  assert.equal(countProfiles(profiles), 1);
});

test('profile count is bounded by evicting the least recently updated', () => {
  let profiles = [];
  for (let index = 0; index < SITE_PROFILE_LIMITS.MAX_PROFILES + 5; index += 1) {
    profiles = upsertProfile(profiles, { origin: `site${index}.com`, originalVolume: 0.5, dubbedVolume: 1 });
  }
  assert.equal(profiles.length, SITE_PROFILE_LIMITS.MAX_PROFILES);
  // The oldest profiles were evicted; the newest survives.
  assert.ok(profiles.some((p) => p.origin === `site${SITE_PROFILE_LIMITS.MAX_PROFILES + 4}.com`));
  assert.equal(profiles.some((p) => p.origin === 'site0.com'), false);
});

test('canAddProfile and free tier 1-profile limit behavior', () => {
  let profiles = [];
  assert.equal(canAddProfile(profiles, 'youtube.com', 1), true);

  // Add 1st profile
  profiles = upsertProfile(profiles, { origin: 'youtube.com', originalVolume: 0.5 }, 1);
  assert.equal(profiles.length, 1);

  // Updating existing profile is allowed under free limit
  assert.equal(canAddProfile(profiles, 'youtube.com', 1), true);
  profiles = upsertProfile(profiles, { origin: 'youtube.com', originalVolume: 0.8 }, 1);
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].originalVolume, 0.8);

  // Adding 2nd profile is rejected by canAddProfile under limit of 1
  assert.equal(canAddProfile(profiles, 'coursera.org', 1), false);
  // Adding under Plus limit (50) is allowed
  assert.equal(canAddProfile(profiles, 'coursera.org', 50), true);
});
