import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SITE_PROFILE_LIMITS,
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
