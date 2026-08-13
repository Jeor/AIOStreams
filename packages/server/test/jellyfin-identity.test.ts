import { describe, expect, it } from 'vitest';
import {
  decodeJellyfinItemId,
  encodeJellyfinItemId,
  identityToStremioRequest,
  parseExternalIdentity,
} from '../src/routes/jellyfin/identity.js';

describe('Jellyfin item identity translation', () => {
  it('round-trips a movie through a stable 32-hex item id', () => {
    const identity = {
      kind: 'movie' as const,
      provider: 'imdb' as const,
      externalId: 'tt1234567',
    };
    const itemId = encodeJellyfinItemId(identity);

    expect(itemId).toMatch(/^[a-f0-9]{32}$/);
    expect(itemId).toBe('41494f4a010171000012d687ffffffff');
    expect(decodeJellyfinItemId(itemId)).toEqual(identity);
    expect(identityToStremioRequest(identity)).toEqual({
      type: 'movie',
      id: 'tt1234567',
    });
  });

  it('preserves leading zeroes in external identifiers', () => {
    const identity = {
      kind: 'movie' as const,
      provider: 'imdb' as const,
      externalId: 'tt0000001',
    };
    expect(decodeJellyfinItemId(encodeJellyfinItemId(identity))).toEqual(
      identity
    );
  });

  it('round-trips an episode and produces the Stremio episode id', () => {
    const identity = {
      kind: 'episode' as const,
      provider: 'tmdb' as const,
      externalId: '98765',
      season: 2,
      episode: 3,
    };

    expect(decodeJellyfinItemId(encodeJellyfinItemId(identity))).toEqual(
      identity
    );
    expect(identityToStremioRequest(identity)).toEqual({
      type: 'series',
      id: 'tmdb:98765:2:3',
    });
  });

  it('round-trips a season identity', () => {
    const identity = {
      kind: 'season' as const,
      provider: 'imdb' as const,
      externalId: 'tt7654321',
      season: 2,
    };
    expect(decodeJellyfinItemId(encodeJellyfinItemId(identity))).toEqual(
      identity
    );
  });

  it('accepts the player alias while rejecting incomplete episodes', () => {
    expect(decodeJellyfinItemId('movie:imdb:tt1234567')).toEqual({
      kind: 'movie',
      provider: 'imdb',
      externalId: 'tt1234567',
    });
    expect(
      parseExternalIdentity({
        kind: 'episode',
        provider: 'imdb',
        externalId: 'tt1234567',
      })
    ).toBeNull();
  });
});
