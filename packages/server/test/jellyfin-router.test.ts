import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

const config = {
  api: { enableJellyfinApi: true, sessionTtlSeconds: 3600 },
  bootstrap: {
    baseUrl: 'http://127.0.0.1:3000',
    version: 'test',
  },
  branding: { addonName: 'AIOStreams' },
};

vi.mock('@aiostreams/core', () => ({
  AIOStreams: class {},
  UserRepository: {},
  config,
  createLogger: () => ({ warn: vi.fn(), error: vi.fn() }),
  getSimpleTextHash: (value: string) =>
    createHash('sha256').update(value).digest('hex'),
  isConfigUuid: () => true,
  normaliseAlias: (value: string) => value,
  resolveConfigAlias: vi.fn(),
  validateConfig: (value: unknown) => value,
  encodeSignedPayload: (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url'),
  decodeSignedPayload: (value: string | undefined) => {
    if (!value) return null;
    try {
      return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
  },
  encryptString: (value: string) => ({
    success: true,
    data: Buffer.from(value).toString('base64url'),
    error: null,
  }),
  decryptString: (value: string) => ({
    success: true,
    data: Buffer.from(value, 'base64url').toString('utf8'),
    error: null,
  }),
}));

vi.mock('../src/utils/syncUserData.js', () => ({
  syncUserDataUrls: (value: unknown) => value,
}));

vi.mock('../src/middlewares/ratelimit.js', () => ({
  streamApiRateLimiter: (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) =>
      server?.close((error) => (error ? reject(error) : resolve()))
    );
    server = undefined;
  }
});

describe('Jellyfin player API', () => {
  it('authenticates, translates an item, returns one safe source, and redirects', async () => {
    const { createJellyfinRouter } =
      await import('../src/routes/jellyfin/index.js');
    const app = express();
    app.use(express.json());
    app.use(
      '/jellyfin',
      createJellyfinRouter({
        authenticate: async () => ({ uuid: 'user-1' }),
        loadUser: async () => ({ uuid: 'user-1' }) as never,
        listStreams: async () =>
          [
            {
              id: 'direct',
              url: 'https://provider.example/movie.mkv',
              addon: { name: 'Provider' },
            },
            {
              id: 'owned',
              url: 'http://127.0.0.1:3000/proxy/movie',
              addon: { name: 'Owned' },
            },
            {
              id: 'headers',
              url: 'https://provider.example/header-only',
              requestHeaders: { Authorization: 'secret' },
              addon: { name: 'Headers' },
            },
          ] as never,
        nowSeconds: () => 100,
      })
    );
    server = createServer(app);
    await new Promise<void>((resolve) =>
      server?.listen(0, '127.0.0.1', resolve)
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('No test address');
    const base = `http://127.0.0.1:${address.port}/jellyfin`;

    const login = await fetch(`${base}/Users/AuthenticateByName`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Username: 'user-1', Pw: 'password' }),
    });
    expect(login.status).toBe(200);
    const accessToken = ((await login.json()) as { AccessToken: string })
      .AccessToken;

    const resolved = await fetch(
      `${base}/Items/Resolve?Kind=Movie&Provider=Imdb&Id=tt1234567`,
      { headers: { 'X-Emby-Token': accessToken } }
    );
    const item = (await resolved.json()) as { Id: string };
    expect(item.Id).toBe('41494f4a010171000012d687ffffffff');

    const playback = await fetch(`${base}/Items/${item.Id}/PlaybackInfo`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Emby-Token': accessToken,
      },
      body: '{}',
    });
    const playbackInfo = (await playback.json()) as {
      MediaSources: Array<{
        Id: string;
        Path: string;
        SupportsDirectPlay: boolean;
        SupportsTranscoding: boolean;
      }>;
    };
    expect(playbackInfo.MediaSources).toHaveLength(1);
    expect(playbackInfo.MediaSources[0]).toMatchObject({
      SupportsDirectPlay: true,
      SupportsTranscoding: false,
    });

    const redirectPath = new URL(playbackInfo.MediaSources[0]!.Path);
    const redirect = await fetch(
      `${base}${redirectPath.pathname.replace('/jellyfin', '')}${redirectPath.search}`,
      { redirect: 'manual' }
    );
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBe(
      'https://provider.example/movie.mkv'
    );

    const clientConstructedRedirect = await fetch(
      `${base}/Videos/${item.Id}/stream?MediaSourceId=${encodeURIComponent(playbackInfo.MediaSources[0]!.Id)}`,
      { redirect: 'manual' }
    );
    expect(clientConstructedRedirect.status).toBe(302);
    expect(clientConstructedRedirect.headers.get('location')).toBe(
      'https://provider.example/movie.mkv'
    );
  });
});
