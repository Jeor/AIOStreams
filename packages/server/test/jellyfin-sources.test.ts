import { describe, expect, it } from 'vitest';
import {
  directProviderUrl,
  safeExternalHttpUrl,
  sourceContainer,
} from '../src/routes/jellyfin/sources.js';

const baseUrl = 'https://aiostreams.example';

describe('Jellyfin direct source policy', () => {
  it('accepts an external HTTP provider URL without headers', () => {
    const stream = { url: 'https://provider.example/video/movie.mkv' };
    expect(directProviderUrl(stream, baseUrl)).toBe(stream.url);
    expect(sourceContainer(stream)).toBe('mkv');
  });

  it.each([
    [{ url: 'https://aiostreams.example/proxy/video' }],
    [{ url: 'https://provider.example/video', proxied: true }],
    [
      {
        url: 'https://provider.example/video',
        requestHeaders: { Authorization: 'secret' },
      },
    ],
    [{ url: 'magnet:?xt=urn:btih:1234' }],
  ])(
    'rejects proxy, owned, header-dependent, and non-HTTP sources',
    (stream) => {
      expect(directProviderUrl(stream, baseUrl)).toBeNull();
    }
  );

  it('permits only external HTTP(S) redirect targets', () => {
    expect(
      safeExternalHttpUrl('http://provider.example/file.mp4', baseUrl)
    ).toBe(true);
    expect(safeExternalHttpUrl('file:///tmp/movie.mkv', baseUrl)).toBe(false);
    expect(
      safeExternalHttpUrl('https://aiostreams.example/media', baseUrl)
    ).toBe(false);
  });
});
