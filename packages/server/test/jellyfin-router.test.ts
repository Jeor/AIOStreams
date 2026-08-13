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
        searchItems: async (_userData, query, types) => {
          if (types.includes('series')) {
            return [
              {
                id: 'tt7654321',
                type: 'series',
                name: 'Example Series',
                poster: 'https://images.example/series.jpg',
                releaseInfo: '2020',
              },
            ] as never;
          }
          expect(query).toBe('The Matrix');
          return [
            {
              id: 'tt0133093',
              type: 'movie',
              name: 'The Matrix',
              poster: 'https://images.example/matrix.jpg',
              releaseInfo: '1999',
              imdbRating: 8.7,
              description: 'A simulated reality.',
            },
          ] as never;
        },
        browseItems: async (_userData, type) =>
          type === 'movie'
            ? ([
                {
                  id: 'tt0133093',
                  type: 'movie',
                  name: 'The Matrix',
                  poster: 'https://images.example/matrix.jpg',
                  releaseInfo: '1999',
                },
              ] as never)
            : ([
                {
                  id: 'tt7654321',
                  type: 'series',
                  name: 'Example Series',
                  poster: 'https://images.example/series.jpg',
                  releaseInfo: '2020',
                },
              ] as never),
        getMetadata: async (_userData, identity) =>
          ({
            id: identity.externalId,
            type: identity.kind === 'movie' ? 'movie' : 'series',
            name: identity.kind === 'movie' ? 'The Matrix' : 'Example Series',
            poster: 'https://images.example/poster.jpg',
            background: 'https://images.example/backdrop.jpg',
            description: 'Full metadata.',
            releaseInfo: '1999',
            videos:
              identity.kind === 'movie'
                ? undefined
                : [
                    {
                      id: 'tt7654321:1:1',
                      title: 'Pilot',
                      season: 1,
                      episode: 1,
                      released: '2020-01-01',
                      thumbnail: 'https://images.example/episode.jpg',
                    },
                  ],
          }) as never,
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

    const publicSystemInfo = await fetch(`${base}/System/Info/Public`);
    expect(publicSystemInfo.status).toBe(200);
    expect(await publicSystemInfo.json()).toMatchObject({ Version: '10.10.7' });

    const login = await fetch(`${base}/Users/AuthenticateByName`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Username: 'user-1', Pw: 'password' }),
    });
    expect(login.status).toBe(200);
    const accessToken = ((await login.json()) as { AccessToken: string })
      .AccessToken;
    const infuseHeaders = {
      'X-Emby-Authorization': `MediaBrowser Token="${accessToken}", Client="Infuse-Direct", Version="8.5"`,
    };

    const systemInfo = await fetch(`${base}/System/Info`, {
      headers: infuseHeaders,
    });
    expect(systemInfo.status).toBe(200);
    expect(await systemInfo.json()).toMatchObject({ Version: '10.10.7' });

    const groupingOptions = await fetch(`${base}/UserViews/GroupingOptions`, {
      headers: infuseHeaders,
    });
    expect(groupingOptions.status).toBe(200);
    expect(await groupingOptions.json()).toEqual([]);

    const views = await fetch(`${base}/UserViews`, {
      headers: infuseHeaders,
    });
    const viewsResult = (await views.json()) as {
      Items: Array<{ Type: string; CollectionType: string }>;
    };
    expect(viewsResult.Items).toEqual([
      expect.objectContaining({
        Type: 'CollectionFolder',
        CollectionType: 'movies',
      }),
      expect.objectContaining({
        Type: 'CollectionFolder',
        CollectionType: 'tvshows',
      }),
    ]);

    const virtualFolders = await fetch(`${base}/Library/VirtualFolders`, {
      headers: infuseHeaders,
    });
    expect(virtualFolders.status).toBe(200);
    const folders = (await virtualFolders.json()) as Array<{
      Name: string;
      CollectionType: string;
      ItemId: string;
      Locations: string[];
      LibraryOptions: Record<string, unknown>;
    }>;
    expect(folders).toEqual([
      expect.objectContaining({
        Name: 'AIOStreams Movie Search',
        CollectionType: 'movies',
        ItemId: expect.any(String),
        Locations: [],
        LibraryOptions: expect.objectContaining({
          Enabled: true,
          PathInfos: [],
        }),
      }),
      expect.objectContaining({
        Name: 'AIOStreams Series Search',
        CollectionType: 'tvshows',
        ItemId: expect.any(String),
        Locations: [],
      }),
    ]);

    const virtualFolderDetails = await fetch(
      `${base}/Users/user-id/Items/${folders[0]!.ItemId}`,
      { headers: infuseHeaders }
    );
    expect(virtualFolderDetails.status).toBe(200);
    expect(await virtualFolderDetails.json()).toMatchObject({
      Id: folders[0]!.ItemId,
      Type: 'CollectionFolder',
      CollectionType: 'movies',
    });

    const libraryItems = await fetch(
      `${base}/Users/user-id/Items?ParentId=${folders[0]!.ItemId}&Recursive=true&ExcludeLocationTypes=Virtual&IncludeItemTypes=Movie`,
      { headers: infuseHeaders }
    );
    expect(libraryItems.status).toBe(200);
    const libraryResult = (await libraryItems.json()) as {
      Items: Array<Record<string, unknown>>;
    };
    expect(libraryResult.Items).toEqual([
      expect.objectContaining({
        Name: 'The Matrix',
        Type: 'Movie',
        ParentId: folders[0]!.ItemId,
        LocationType: 'FileSystem',
      }),
    ]);

    const endpointInfo = await fetch(`${base}/System/Endpoint`, {
      headers: infuseHeaders,
    });
    expect(endpointInfo.status).toBe(200);
    expect(await endpointInfo.json()).toMatchObject({
      IsLocal: true,
      IsInNetwork: true,
      Address: `${config.bootstrap.baseUrl}/jellyfin`,
    });

    const users = await fetch(`${base}/Users`, { headers: infuseHeaders });
    expect(users.status).toBe(200);
    expect(await users.json()).toEqual([
      expect.objectContaining({ Id: expect.any(String), Name: 'user-1' }),
    ]);

    const statelessResponses: Array<[string, unknown]> = [
      ['/Sessions', []],
      [
        '/Items/Filters',
        { Genres: [], Tags: [], OfficialRatings: [], Years: [] },
      ],
      [
        '/Items/Filters2',
        {
          Genres: [],
          Tags: [],
          AudioLanguages: [],
          SubtitleLanguages: [],
        },
      ],
      ['/Items/Latest', []],
      ['/Users/user-id/Items/Latest', []],
      ['/Items/Suggestions', { Items: [], TotalRecordCount: 0, StartIndex: 0 }],
      [
        '/Users/user-id/Items/Resume',
        { Items: [], TotalRecordCount: 0, StartIndex: 0 },
      ],
      ['/UserItems/Resume', { Items: [], TotalRecordCount: 0, StartIndex: 0 }],
      ['/Shows/NextUp', { Items: [], TotalRecordCount: 0, StartIndex: 0 }],
      ['/Shows/Upcoming', { Items: [], TotalRecordCount: 0, StartIndex: 0 }],
    ];
    for (const [path, expected] of statelessResponses) {
      const response = await fetch(`${base}${path}`, {
        headers: infuseHeaders,
      });
      expect(response.status, path).toBe(200);
      expect(await response.json(), path).toEqual(expected);
    }

    const search = await fetch(
      `${base}/Items?SearchTerm=The%20Matrix&IncludeItemTypes=Movie&ExcludeLocationTypes=Virtual&Fields=MediaSources,ProviderIds,Overview`,
      { headers: infuseHeaders }
    );
    expect(search.status).toBe(200);
    const searchResult = (await search.json()) as {
      Items: Array<{
        Id: string;
        Name: string;
        Type: string;
        ProviderIds: Record<string, string>;
        ImageTags: Record<string, string>;
        UserData: Record<string, unknown>;
        ProductionYear: number;
      }>;
    };
    expect(searchResult.Items).toHaveLength(1);
    expect(searchResult.Items[0]).toMatchObject({
      Name: 'The Matrix',
      Type: 'Movie',
      ProviderIds: { Imdb: 'tt0133093' },
      ProductionYear: 1999,
      LocationType: 'FileSystem',
    });
    expect(searchResult.Items[0]!.ImageTags.Primary).toBeTruthy();
    expect(searchResult.Items[0]!.UserData).toBeTruthy();

    const searchedItem = searchResult.Items[0]!;
    const details = await fetch(`${base}/Items/${searchedItem.Id}`, {
      headers: infuseHeaders,
    });
    expect(details.status).toBe(200);
    expect(await details.json()).toMatchObject({
      Id: searchedItem.Id,
      Name: 'The Matrix',
      Overview: 'Full metadata.',
    });

    const artwork = await fetch(
      `${base}/Items/${searchedItem.Id}/Images/Primary`,
      { headers: infuseHeaders, redirect: 'manual' }
    );
    expect(artwork.status).toBe(302);
    expect(artwork.headers.get('location')).toBe(
      'https://images.example/poster.jpg'
    );

    const seriesSearch = await fetch(
      `${base}/Users/user-id/Items?SearchTerm=Example&IncludeItemTypes=Series`,
      { headers: infuseHeaders }
    );
    const series = (
      (await seriesSearch.json()) as {
        Items: Array<{ Id: string; Type: string }>;
      }
    ).Items[0]!;
    expect(series.Type).toBe('Series');

    const seasons = await fetch(`${base}/Shows/${series.Id}/Seasons`, {
      headers: infuseHeaders,
    });
    expect(seasons.status).toBe(200);
    const seasonItems = (
      (await seasons.json()) as { Items: Array<{ Id: string; Type: string }> }
    ).Items;
    expect(seasonItems).toHaveLength(1);
    expect(seasonItems[0]!.Type).toBe('Season');

    const episodes = await fetch(
      `${base}/Shows/${series.Id}/Episodes?Season=1`,
      { headers: infuseHeaders }
    );
    const episodeItems = (
      (await episodes.json()) as {
        Items: Array<{ Id: string; Type: string; Name: string }>;
      }
    ).Items;
    expect(episodeItems).toHaveLength(1);
    expect(episodeItems[0]).toMatchObject({ Type: 'Episode', Name: 'Pilot' });

    const resolved = await fetch(
      `${base}/Items/Resolve?Kind=Movie&Provider=Imdb&Id=tt1234567`,
      { headers: { 'X-Emby-Token': accessToken } }
    );
    const item = (await resolved.json()) as { Id: string };
    expect(item.Id).toBe('41494f4a010171000012d687ffffffff');

    const localTrailers = await fetch(
      `${base}/Items/${item.Id}/LocalTrailers`,
      { headers: infuseHeaders }
    );
    expect(localTrailers.status).toBe(200);
    expect(await localTrailers.json()).toEqual([]);

    const userData = await fetch(`${base}/UserItems/${item.Id}/UserData`, {
      headers: infuseHeaders,
    });
    expect(userData.status).toBe(200);
    expect(await userData.json()).toMatchObject({
      Key: item.Id,
      IsFavorite: false,
      Played: false,
    });

    const updatedPreferences = await fetch(
      `${base}/DisplayPreferences/home?client=Infuse`,
      { method: 'POST', headers: infuseHeaders, body: '{}' }
    );
    expect(updatedPreferences.status).toBe(204);

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
