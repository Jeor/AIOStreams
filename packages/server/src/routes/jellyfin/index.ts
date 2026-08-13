import { Router, type Request, type Response } from 'express';
import {
  AIOStreams,
  type Meta,
  type MetaPreview,
  type ParsedStream,
  type UserData,
  UserRepository,
  config as appConfig,
  createLogger,
  getSimpleTextHash,
  isConfigUuid,
  normaliseAlias,
  resolveConfigAlias,
  validateConfig,
} from '@aiostreams/core';
import { syncUserDataUrls } from '../../utils/syncUserData.js';
import { streamApiRateLimiter } from '../../middlewares/ratelimit.js';
import {
  decodeJellyfinItemId,
  encodeJellyfinItemId,
  identityToStremioMetaRequest,
  identityToStremioRequest,
  jellyfinItemDto,
  parseExternalIdentity,
  type JellyfinMediaIdentity,
} from './identity.js';
import {
  issueJellyfinAccessToken,
  issueJellyfinSourceToken,
  readJellyfinAccessToken,
  readJellyfinSourceToken,
  type JellyfinAccessGrant,
} from './tokens.js';
import {
  directProviderUrl,
  safeExternalHttpUrl,
  sourceContainer,
} from './sources.js';
import {
  identityFromCatalogItem,
  imageForItem,
  jellyfinMetadataItem,
  seriesEpisodes,
  seriesSeasons,
  virtualViews,
} from './items.js';

const logger = createLogger('jellyfin-api');
const SOURCE_TOKEN_TTL_SECONDS = 5 * 60;
const JELLYFIN_COMPATIBILITY_VERSION = '10.10.7';

export interface JellyfinApiDependencies {
  authenticate(username: string, password: string): Promise<{ uuid: string }>;
  loadUser(grant: JellyfinAccessGrant, ip?: string): Promise<UserData>;
  listStreams(
    userData: UserData,
    request: { type: 'movie' | 'series'; id: string }
  ): Promise<readonly ParsedStream[]>;
  searchItems(
    userData: UserData,
    query: string,
    types: readonly ('movie' | 'series')[]
  ): Promise<readonly MetaPreview[]>;
  browseItems(
    userData: UserData,
    type: 'movie' | 'series'
  ): Promise<readonly MetaPreview[]>;
  getMetadata(
    userData: UserData,
    identity: JellyfinMediaIdentity
  ): Promise<Meta | null>;
  nowSeconds(): number;
}

const defaultDependencies: JellyfinApiDependencies = {
  async authenticate(username, password) {
    const normalized = username.trim();
    const alias = isConfigUuid(normalized)
      ? null
      : await resolveConfigAlias(normaliseAlias(normalized));
    const uuid = alias?.uuid ?? normalized;
    const userData = await UserRepository.getUser(uuid, password);
    if (!userData) throw new Error('AIOStreams user was not found');
    return { uuid };
  },

  async loadUser(grant, ip) {
    let userData = await UserRepository.getUser(grant.uuid, grant.password);
    if (!userData) throw new Error('AIOStreams user was not found');
    userData.ip = ip;
    userData = await syncUserDataUrls(userData);
    return validateConfig(userData, {
      skipErrorsFromAddonsOrProxies: true,
      decryptValues: true,
    });
  },

  async listStreams(userData, request) {
    const aiostreams = await new AIOStreams(userData).initialise();
    const response = await aiostreams.getControlPlaneStreams(
      request.id,
      request.type
    );
    return response.data.streams;
  },

  async searchItems(userData, query, types) {
    const aiostreams = await new AIOStreams(userData).initialise();
    const catalogs = aiostreams.getCatalogs();
    const searchable = types.flatMap((type) =>
      catalogs
        .filter(
          (candidate) =>
            candidate.type.toLowerCase() === type &&
            candidate.extra?.some(
              (extra) => extra.name.toLowerCase() === 'search'
            )
        )
        .sort(
          (a, b) => Number(/people/i.test(a.id)) - Number(/people/i.test(b.id))
        )
        .map((catalog) => ({ type, catalog }))
    );
    const results = await Promise.allSettled(
      searchable.map(({ type, catalog }) =>
        aiostreams.getCatalog(
          type,
          catalog.id,
          new URLSearchParams({ search: query }).toString()
        )
      )
    );
    const items = results.flatMap((result) =>
      result.status === 'fulfilled' ? result.value.data : []
    );
    logger.debug(
      {
        queryLength: query.length,
        types,
        catalogs: searchable.length,
        results: items.length,
      },
      'Infuse Jellyfin catalog search complete'
    );
    return items;
  },

  async browseItems(userData, type) {
    const aiostreams = await new AIOStreams(userData).initialise();
    const catalog = aiostreams
      .getCatalogs()
      .find(
        (candidate) =>
          candidate.type.toLowerCase() === type &&
          !candidate.extra?.some((extra) => extra.isRequired)
      );
    if (!catalog) return [];
    const response = await aiostreams.getCatalog(type, catalog.id);
    logger.debug(
      { type, catalog: catalog.id, results: response.data.length },
      'Infuse Jellyfin library browse complete'
    );
    return response.data;
  },

  async getMetadata(userData, identity) {
    const aiostreams = await new AIOStreams(userData).initialise();
    const request = identityToStremioMetaRequest(identity);
    const response = await aiostreams.getMeta(request.type, request.id);
    return response.data;
  },

  nowSeconds: () => Math.floor(Date.now() / 1000),
};

export function createJellyfinRouter(
  dependencies: JellyfinApiDependencies = defaultDependencies
): Router {
  const router = Router();

  router.use((req, res, next) => {
    if (!appConfig.api.enableJellyfinApi) {
      res.status(404).json({ Message: 'Jellyfin player API is disabled' });
      return;
    }
    next();
  });
  router.use(streamApiRateLimiter);

  router.get('/System/Info/Public', (_req, res) => {
    res.status(200).json(serverInfo());
  });

  router.get('/System/Info', async (req, res) => {
    const auth = await authenticated(req, res, dependencies);
    if (!auth) return;
    res.status(200).json({
      ...serverInfo(),
      WanAddress: serverInfo().LocalAddress,
      WebSocketPortNumber: null,
      CompletedInstallations: [],
      CanSelfRestart: false,
      CanLaunchWebBrowser: false,
      HasPendingRestart: false,
      SupportsLibraryMonitor: false,
      EncoderLocation: 'NotFound',
      SystemArchitecture: process.arch,
    });
  });

  router.get('/System/Endpoint', async (req, res) => {
    const auth = await authenticated(req, res, dependencies);
    if (!auth) return;
    res.status(200).json({
      IsLocal: true,
      IsInNetwork: true,
      Address: serverInfo().LocalAddress,
    });
  });

  router.get('/System/Ping', (_req, res) => res.status(200).send('Jellyfin'));
  router.post('/System/Ping', (_req, res) => res.status(204).end());
  router.get('/QuickConnect/Enabled', (_req, res) =>
    res.status(200).json(false)
  );
  router.get('/Branding/Configuration', (_req, res) =>
    res.status(200).json({
      LoginDisclaimer: '',
      CustomCssCode: '',
      SplashscreenEnabled: false,
    })
  );

  router.post('/Users/AuthenticateByName', async (req, res) => {
    try {
      const username = bodyString(req, 'Username');
      const password = bodyString(req, 'Pw') ?? bodyString(req, 'Password');
      if (!username || !password) {
        problem(res, 400, 'Username and password are required');
        return;
      }
      const { uuid } = await dependencies.authenticate(username, password);
      const accessToken = issueJellyfinAccessToken(
        uuid,
        password,
        appConfig.api.sessionTtlSeconds,
        dependencies.nowSeconds()
      );
      const user = userDto(uuid, username);
      res.status(200).json({
        User: user,
        SessionInfo: {
          UserId: user.Id,
          UserName: user.Name,
          Client: requestClient(req),
          DeviceName: requestDevice(req),
        },
        AccessToken: accessToken,
        ServerId: serverId(),
      });
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Jellyfin authentication failed'
      );
      problem(res, 401, 'Invalid username or password');
    }
  });

  router.get('/Users/Me', async (req, res) => {
    const auth = await authenticated(req, res, dependencies);
    if (!auth) return;
    res.status(200).json(userDto(auth.grant.uuid, auth.grant.uuid));
  });

  router.get('/Users/Public', (_req, res) => res.status(200).json([]));

  router.get('/Users', async (req, res) => {
    const auth = await authenticated(req, res, dependencies);
    if (!auth) return;
    res.status(200).json([userDto(auth.grant.uuid, auth.grant.uuid)]);
  });

  router.get('/Users/:userId', async (req, res) => {
    const auth = await authenticated(req, res, dependencies);
    if (!auth) return;
    const user = userDto(auth.grant.uuid, auth.grant.uuid);
    if (pathParameter(req, 'userId') !== user.Id) {
      problem(res, 404, 'User not found');
      return;
    }
    res.status(200).json(user);
  });

  const viewsHandler = async (req: Request, res: Response) => {
    const auth = await authenticated(req, res, dependencies);
    if (!auth) return;
    const views = virtualViews(auth.grant.uuid);
    res.status(200).json(itemQuery(views));
  };
  router.get('/Users/:userId/Views', viewsHandler);
  router.get('/UserViews/GroupingOptions', async (req, res) => {
    const auth = await authenticated(req, res, dependencies);
    if (!auth) return;
    res.status(200).json([]);
  });
  router.get('/UserViews', viewsHandler);

  router.get('/Library/VirtualFolders', async (req, res) => {
    const auth = await authenticated(req, res, dependencies);
    if (!auth) return;
    res.status(200).json(
      virtualViews(auth.grant.uuid).map((view) => ({
        Name: view.Name,
        Locations: [],
        CollectionType: view.CollectionType,
        ItemId: view.Id,
        LibraryOptions: {
          Enabled: true,
          EnableRealtimeMonitor: false,
          EnableInternetProviders: false,
          SeasonZeroDisplayName: 'Specials',
          TypeOptions: [],
          PathInfos: [],
        },
      }))
    );
  });

  const capabilitiesHandler = async (req: Request, res: Response) => {
    const auth = await authenticated(req, res, dependencies);
    if (!auth) return;
    res.status(204).end();
  };
  router.post('/Sessions/Capabilities', capabilitiesHandler);
  router.post('/Sessions/Capabilities/Full', capabilitiesHandler);

  router.get('/Sessions', async (req, res) => {
    const auth = await authenticated(req, res, dependencies);
    if (!auth) return;
    res.status(200).json([]);
  });
  router.post('/Sessions/Logout', capabilitiesHandler);

  const emptyItemQueryHandler = async (req: Request, res: Response) => {
    const auth = await authenticated(req, res, dependencies);
    if (!auth) return;
    res.status(200).json(paginatedItemQuery(req, []));
  };
  const emptyItemArrayHandler = async (req: Request, res: Response) => {
    const auth = await authenticated(req, res, dependencies);
    if (!auth) return;
    res.status(200).json([]);
  };

  router.get('/Items/Filters', async (req, res) => {
    const auth = await authenticated(req, res, dependencies);
    if (!auth) return;
    res.status(200).json({
      Genres: [],
      Tags: [],
      OfficialRatings: [],
      Years: [],
    });
  });
  router.get('/Items/Filters2', async (req, res) => {
    const auth = await authenticated(req, res, dependencies);
    if (!auth) return;
    res.status(200).json({
      Genres: [],
      Tags: [],
      AudioLanguages: [],
      SubtitleLanguages: [],
    });
  });
  router.get('/Items/Latest', emptyItemArrayHandler);
  router.get('/Users/:userId/Items/Latest', emptyItemArrayHandler);
  router.get('/Items/Suggestions', emptyItemQueryHandler);
  router.get('/Users/:userId/Items/Resume', emptyItemQueryHandler);
  router.get('/UserItems/Resume', emptyItemQueryHandler);
  router.get('/Shows/NextUp', emptyItemQueryHandler);
  router.get('/Shows/Upcoming', emptyItemQueryHandler);

  // AIOStreams discovery extension: translate an external provider identity to
  // the stable 32-hex item ID subsequently used by official Jellyfin routes.
  router.get('/Items/Resolve', async (req, res) => {
    const auth = await authenticated(req, res, dependencies);
    if (!auth) return;
    const identity = identityFromQuery(req);
    if (!identity) {
      problem(res, 400, 'A valid media identity is required');
      return;
    }
    res.status(200).json(jellyfinItemDto(identity));
  });

  const itemsHandler = async (req: Request, res: Response) => {
    const auth = await authenticated(req, res, dependencies);
    if (!auth) return;

    const searchTerm = queryString(req, 'SearchTerm')?.trim();
    if (searchTerm) {
      try {
        const requestedTypes = searchTypes(req);
        const metas = await dependencies.searchItems(
          auth.userData,
          searchTerm,
          requestedTypes
        );
        const seen = new Set<string>();
        const items = metas.flatMap((meta) => {
          const type = meta.type.toLowerCase();
          const kind = type === 'series' ? 'series' : 'movie';
          if (!requestedTypes.includes(kind)) return [];
          const identity = identityFromCatalogItem(meta, kind);
          if (!identity) return [];
          const id = encodeJellyfinItemId(identity);
          if (seen.has(id)) return [];
          seen.add(id);
          return [jellyfinMetadataItem(identity, meta)];
        });
        res.status(200).json(paginatedItemQuery(req, items));
      } catch (error) {
        logger.error(
          { error: error instanceof Error ? error.message : String(error) },
          'Infuse Jellyfin search failed'
        );
        problem(res, 502, 'AIOStreams could not search metadata catalogs');
      }
      return;
    }

    const parentId = queryString(req, 'ParentId');
    if (parentId) {
      const view = virtualViews(auth.grant.uuid).find(
        (candidate) => candidate.Id === parentId
      );
      if (view) {
        const type = view.CollectionType === 'tvshows' ? 'series' : 'movie';
        try {
          const metas = await dependencies.browseItems(auth.userData, type);
          const seen = new Set<string>();
          const items = metas.flatMap((meta) => {
            const identity = identityFromCatalogItem(meta, type);
            if (!identity) return [];
            const id = encodeJellyfinItemId(identity);
            if (seen.has(id)) return [];
            seen.add(id);
            return [
              jellyfinMetadataItem(identity, meta, { parentId: view.Id }),
            ];
          });
          res.status(200).json(paginatedItemQuery(req, items));
        } catch (error) {
          logger.error(
            {
              type,
              error: error instanceof Error ? error.message : String(error),
            },
            'Infuse Jellyfin library browse failed'
          );
          problem(res, 502, 'AIOStreams could not browse metadata catalogs');
        }
        return;
      }
      const parent = decodeJellyfinItemId(parentId);
      if (parent?.kind === 'series' || parent?.kind === 'season') {
        try {
          const seriesIdentity: JellyfinMediaIdentity = {
            ...parent,
            kind: 'series',
            season: undefined,
            episode: undefined,
          };
          const metadata = await dependencies.getMetadata(
            auth.userData,
            seriesIdentity
          );
          const items =
            parent.kind === 'series'
              ? seriesSeasons(seriesIdentity, metadata)
              : seriesEpisodes(seriesIdentity, metadata, parent.season);
          res.status(200).json(paginatedItemQuery(req, items));
        } catch {
          problem(res, 502, 'AIOStreams could not load series metadata');
        }
        return;
      }
    }

    const identity = identityFromItemsQuery(req);
    const items = identity ? [jellyfinMetadataItem(identity)] : [];
    res.status(200).json(itemQuery(items));
  };
  router.get('/Items', itemsHandler);
  router.get('/Users/:userId/Items', itemsHandler);

  router.get('/Search/Hints', async (req, res) => {
    const auth = await authenticated(req, res, dependencies);
    if (!auth) return;
    const searchTerm = queryString(req, 'SearchTerm')?.trim();
    if (!searchTerm) {
      res.status(200).json({ SearchHints: [], TotalRecordCount: 0 });
      return;
    }
    try {
      const requestedTypes = searchTypes(req);
      const metas = await dependencies.searchItems(
        auth.userData,
        searchTerm,
        requestedTypes
      );
      const hints = metas.flatMap((meta) => {
        const kind = meta.type.toLowerCase() === 'series' ? 'series' : 'movie';
        if (!requestedTypes.includes(kind)) return [];
        const identity = identityFromCatalogItem(meta, kind);
        if (!identity) return [];
        const item = jellyfinMetadataItem(identity, meta);
        return [
          {
            ItemId: item.Id,
            Id: item.Id,
            Name: item.Name,
            Type: item.Type,
            MediaType: item.MediaType,
            PrimaryImageTag: item.ImageTags.Primary,
            ProductionYear: item.ProductionYear,
          },
        ];
      });
      const page = paginated(req, hints);
      res.status(200).json({
        SearchHints: page.items,
        TotalRecordCount: hints.length,
      });
    } catch {
      problem(res, 502, 'AIOStreams could not search metadata catalogs');
    }
  });

  router.get('/Shows/:seriesId/Seasons', async (req, res) => {
    const auth = await authenticated(req, res, dependencies);
    if (!auth) return;
    const identity = decodeJellyfinItemId(pathParameter(req, 'seriesId') ?? '');
    if (identity?.kind !== 'series') {
      problem(res, 404, 'Series not found');
      return;
    }
    try {
      const metadata = await dependencies.getMetadata(auth.userData, identity);
      res
        .status(200)
        .json(paginatedItemQuery(req, seriesSeasons(identity, metadata)));
    } catch {
      problem(res, 502, 'AIOStreams could not load series metadata');
    }
  });

  router.get('/Shows/:seriesId/Episodes', async (req, res) => {
    const auth = await authenticated(req, res, dependencies);
    if (!auth) return;
    const identity = decodeJellyfinItemId(pathParameter(req, 'seriesId') ?? '');
    if (identity?.kind !== 'series') {
      problem(res, 404, 'Series not found');
      return;
    }
    const season = nonNegativeInteger(queryString(req, 'Season'));
    try {
      const metadata = await dependencies.getMetadata(auth.userData, identity);
      res
        .status(200)
        .json(
          paginatedItemQuery(req, seriesEpisodes(identity, metadata, season))
        );
    } catch {
      problem(res, 502, 'AIOStreams could not load series metadata');
    }
  });

  router.get('/Items/:itemId', async (req, res) => {
    const auth = await authenticated(req, res, dependencies);
    if (!auth) return;
    const itemId = pathParameter(req, 'itemId') ?? '';
    const view = virtualViews(auth.grant.uuid).find(
      (candidate) => candidate.Id === itemId
    );
    if (view) {
      res.status(200).json(view);
      return;
    }
    const identity = decodeJellyfinItemId(itemId);
    if (!identity) {
      problem(res, 404, 'Item not found');
      return;
    }
    try {
      const metadata = await dependencies.getMetadata(auth.userData, identity);
      res.status(200).json(jellyfinMetadataItem(identity, metadata));
    } catch {
      problem(res, 502, 'AIOStreams could not load item metadata');
    }
  });

  router.get('/Users/:userId/Items/:itemId', async (req, res) => {
    const auth = await authenticated(req, res, dependencies);
    if (!auth) return;
    const itemId = pathParameter(req, 'itemId') ?? '';
    const view = virtualViews(auth.grant.uuid).find(
      (candidate) => candidate.Id === itemId
    );
    if (view) {
      res.status(200).json(view);
      return;
    }
    const identity = decodeJellyfinItemId(itemId);
    if (!identity) {
      problem(res, 404, 'Item not found');
      return;
    }
    try {
      const metadata = await dependencies.getMetadata(auth.userData, identity);
      res.status(200).json(jellyfinMetadataItem(identity, metadata));
    } catch {
      problem(res, 502, 'AIOStreams could not load item metadata');
    }
  });

  const playbackInfoHandler = async (req: Request, res: Response) => {
    const auth = await authenticated(req, res, dependencies);
    if (!auth) return;
    const identity = decodeJellyfinItemId(pathParameter(req, 'itemId') ?? '');
    const stremioRequest = identity && identityToStremioRequest(identity);
    if (!identity || !stremioRequest) {
      problem(res, 404, 'Playable item not found');
      return;
    }

    try {
      const streams = await dependencies.listStreams(
        auth.userData,
        stremioRequest
      );
      const itemId = encodeJellyfinItemId(identity);
      const mediaSources = streams.flatMap((stream, index) => {
        const sourceUrl = directProviderUrl(
          stream,
          appConfig.bootstrap.baseUrl
        );
        if (!sourceUrl) return [];
        const sourceToken = issueJellyfinSourceToken(
          auth.grant.uuid,
          itemId,
          sourceUrl,
          SOURCE_TOKEN_TTL_SECONDS,
          dependencies.nowSeconds()
        );
        return [mediaSource(stream, itemId, sourceToken, index)];
      });
      res.status(200).json({
        MediaSources: mediaSources,
        PlaySessionId: getSimpleTextHash(
          `${auth.grant.uuid}:${itemId}:${dependencies.nowSeconds()}`
        ).slice(0, 32),
        ErrorCode: null,
      });
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Jellyfin PlaybackInfo resolution failed'
      );
      problem(res, 502, 'AIOStreams could not resolve playback sources');
    }
  };
  router.get('/Items/:itemId/PlaybackInfo', playbackInfoHandler);
  router.post('/Items/:itemId/PlaybackInfo', playbackInfoHandler);

  const redirectHandler = (req: Request, res: Response) => {
    const requestedItemId = pathParameter(req, 'itemId');
    const canonicalId = requestedItemId
      ? decodeJellyfinItemId(requestedItemId)
      : null;
    if (!canonicalId) {
      problem(res, 404, 'Item not found');
      return;
    }
    const itemId = encodeJellyfinItemId(canonicalId);
    const sourceToken =
      queryString(req, 'source') ??
      queryString(req, 'MediaSourceId') ??
      queryString(req, 'mediaSourceId');
    const grant = readJellyfinSourceToken(
      sourceToken,
      itemId,
      dependencies.nowSeconds()
    );
    if (
      !grant ||
      !safeExternalHttpUrl(grant.sourceUrl, appConfig.bootstrap.baseUrl)
    ) {
      problem(res, 401, 'Playback source is invalid or expired');
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, grant.sourceUrl);
  };
  router.get('/Videos/:itemId/stream', redirectHandler);
  router.get('/Videos/:itemId/stream.:container', redirectHandler);

  const imageHandler = async (req: Request, res: Response) => {
    const auth = await authenticated(req, res, dependencies);
    if (!auth) return;
    const identity = decodeJellyfinItemId(pathParameter(req, 'itemId') ?? '');
    if (!identity) {
      problem(res, 404, 'Item not found');
      return;
    }
    try {
      const metadata = await dependencies.getMetadata(auth.userData, identity);
      const imageUrl = imageForItem(
        identity,
        metadata,
        pathParameter(req, 'imageType') ?? 'Primary'
      );
      if (!imageUrl || !httpUrl(imageUrl)) {
        problem(res, 404, 'Image not found');
        return;
      }
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.redirect(302, imageUrl);
    } catch {
      problem(res, 502, 'AIOStreams could not load item artwork');
    }
  };
  router.get('/Items/:itemId/Images/:imageType', imageHandler);
  router.get('/Items/:itemId/Images/:imageType/:imageIndex', imageHandler);

  router.get('/Items/:itemId/LocalTrailers', emptyItemArrayHandler);
  router.get(
    '/Users/:userId/Items/:itemId/LocalTrailers',
    emptyItemArrayHandler
  );
  router.get('/Items/:itemId/SpecialFeatures', emptyItemArrayHandler);
  router.get(
    '/Users/:userId/Items/:itemId/SpecialFeatures',
    emptyItemArrayHandler
  );
  router.get('/Items/:itemId/Ancestors', emptyItemArrayHandler);

  const playbackEventHandler = async (req: Request, res: Response) => {
    const auth = await authenticated(req, res, dependencies);
    if (!auth) return;
    res.status(204).end();
  };
  router.post('/Sessions/Playing', playbackEventHandler);
  router.post('/Sessions/Playing/Progress', playbackEventHandler);
  router.post('/Sessions/Playing/Stopped', playbackEventHandler);

  const userDataHandler = async (req: Request, res: Response) => {
    const auth = await authenticated(req, res, dependencies);
    if (!auth) return;
    res.status(200).json(defaultUserData(pathParameter(req, 'itemId')));
  };
  router.get('/Users/:userId/Items/:itemId/UserData', userDataHandler);
  router.get('/UserItems/:itemId/UserData', userDataHandler);

  router.post('/UserItems/:itemId/UserData', async (req, res) => {
    const auth = await authenticated(req, res, dependencies);
    if (!auth) return;
    const update =
      req.body && typeof req.body === 'object'
        ? (req.body as Record<string, unknown>)
        : {};
    res.status(200).json({
      ...defaultUserData(pathParameter(req, 'itemId')),
      ...update,
      Key: pathParameter(req, 'itemId'),
    });
  });

  const favoriteHandler =
    (isFavorite: boolean) => async (req: Request, res: Response) => {
      const auth = await authenticated(req, res, dependencies);
      if (!auth) return;
      res.status(200).json({
        ...defaultUserData(pathParameter(req, 'itemId')),
        IsFavorite: isFavorite,
      });
    };
  router.post('/UserItems/:itemId/Favorite', favoriteHandler(true));
  router.delete('/UserItems/:itemId/Favorite', favoriteHandler(false));

  const playedHandler =
    (played: boolean) => async (req: Request, res: Response) => {
      const auth = await authenticated(req, res, dependencies);
      if (!auth) return;
      res.status(200).json({
        ...defaultUserData(pathParameter(req, 'itemId')),
        PlayCount: played ? 1 : 0,
        Played: played,
      });
    };
  router.post('/UserItems/:itemId/Played', playedHandler(true));
  router.delete('/UserItems/:itemId/Played', playedHandler(false));

  router.get('/DisplayPreferences/:displayPreferencesId', async (req, res) => {
    const auth = await authenticated(req, res, dependencies);
    if (!auth) return;
    res.status(200).json({
      Id: pathParameter(req, 'displayPreferencesId'),
      ViewType: 'Poster',
      SortBy: 'SortName',
      IndexBy: 'None',
      RememberIndexing: false,
      PrimaryImageHeight: 250,
      PrimaryImageWidth: 250,
      CustomPrefs: {},
      ScrollDirection: 'Horizontal',
      ShowBackdrop: true,
      RememberSorting: false,
      SortOrder: 'Ascending',
      ShowSidebar: false,
      Client: requestClient(req),
    });
  });
  router.post('/DisplayPreferences/:displayPreferencesId', capabilitiesHandler);

  return router;
}

async function authenticated(
  req: Request,
  res: Response,
  dependencies: JellyfinApiDependencies
): Promise<{ grant: JellyfinAccessGrant; userData: UserData } | null> {
  const grant = readJellyfinAccessToken(
    requestAccessToken(req),
    dependencies.nowSeconds()
  );
  if (!grant) {
    problem(res, 401, 'Authentication token is missing or invalid');
    return null;
  }
  try {
    const userData = await dependencies.loadUser(grant, req.userIp);
    return { grant, userData };
  } catch {
    problem(res, 401, 'Authentication token is no longer valid');
    return null;
  }
}

function mediaSource(
  stream: ParsedStream,
  itemId: string,
  sourceToken: string,
  index: number
) {
  const container = sourceContainer(stream);
  const suffix = container ? `.${container}` : '';
  const path = `${appConfig.bootstrap.baseUrl.replace(/\/+$/, '')}/jellyfin/Videos/${itemId}/stream${suffix}?source=${encodeURIComponent(sourceToken)}`;
  const name =
    stream.originalName ??
    stream.parsedFile?.title ??
    stream.filename ??
    stream.addon?.name ??
    `Source ${index + 1}`;
  return {
    Protocol: 'Http',
    // Jellyfin clients commonly copy MediaSource.Id into MediaSourceId when
    // constructing the video route themselves. Keeping the signed redirect
    // grant here makes that official request pattern stateless as well.
    Id: sourceToken,
    Path: path,
    Name: name,
    Type: 'Default',
    IsRemote: true,
    ReadAtNativeFramerate: false,
    SupportsDirectPlay: true,
    SupportsDirectStream: false,
    SupportsTranscoding: false,
    IsInfiniteStream: false,
    RequiresOpening: false,
    RequiresClosing: false,
    RequiredHttpHeaders: {},
    MediaStreams: [],
    ...(container ? { Container: container } : {}),
    ...(stream.size ? { Size: stream.size } : {}),
    ...(stream.bitrate ? { Bitrate: stream.bitrate } : {}),
  };
}

function identityFromQuery(req: Request): JellyfinMediaIdentity | null {
  return parseExternalIdentity({
    kind: queryString(req, 'Kind') ?? queryString(req, 'Type') ?? '',
    provider: queryString(req, 'Provider') ?? '',
    externalId: queryString(req, 'Id') ?? queryString(req, 'ProviderId') ?? '',
    season: queryString(req, 'Season'),
    episode: queryString(req, 'Episode'),
  });
}

function identityFromItemsQuery(req: Request): JellyfinMediaIdentity | null {
  const providerFilter = queryString(req, 'AnyProviderIdEquals');
  if (!providerFilter) return null;
  const match = /^(imdb|tmdb|tvdb|mal)[.:=](.+)$/i.exec(providerFilter);
  if (!match) return null;
  const includeType = (queryString(req, 'IncludeItemTypes') ?? 'Movie')
    .split(',')[0]
    ?.toLowerCase();
  return parseExternalIdentity({
    kind:
      includeType === 'episode'
        ? 'episode'
        : includeType === 'series'
          ? 'series'
          : 'movie',
    provider: match[1] ?? '',
    externalId: match[2] ?? '',
    season: queryString(req, 'Season'),
    episode: queryString(req, 'Episode'),
  });
}

function searchTypes(req: Request): Array<'movie' | 'series'> {
  const values = [
    ...queryStrings(req, 'IncludeItemTypes'),
    ...queryStrings(req, 'IncludeItemTypes[]'),
  ];
  const include = (values.length > 0 ? values : ['Movie,Series'])
    .flatMap((value) => value.split(','))
    .map((value) => value.trim().toLowerCase());
  const types: Array<'movie' | 'series'> = [];
  if (include.includes('movie')) types.push('movie');
  if (include.includes('series')) types.push('series');
  return types.length > 0 ? types : ['movie', 'series'];
}

function itemQuery(items: unknown[], startIndex: number = 0) {
  return {
    Items: items,
    TotalRecordCount: items.length,
    StartIndex: startIndex,
  };
}

function paginatedItemQuery(req: Request, items: unknown[]) {
  const page = paginated(req, items);
  return {
    Items: page.items,
    TotalRecordCount: items.length,
    StartIndex: page.start,
  };
}

function paginated<T>(req: Request, items: T[]) {
  const start = nonNegativeInteger(queryString(req, 'StartIndex')) ?? 0;
  const limit = nonNegativeInteger(queryString(req, 'Limit'));
  return {
    start,
    items: items.slice(start, limit === undefined ? undefined : start + limit),
  };
}

function nonNegativeInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function requestAccessToken(req: Request): string | undefined {
  const direct =
    req.get('X-Emby-Token') ??
    req.get('X-MediaBrowser-Token') ??
    req.get('X-Emby-Authorization')?.match(/\bToken="([^"]+)"/i)?.[1];
  if (direct) return direct;
  const query = queryString(req, 'api_key');
  if (query) return query;
  const authorization = req.get('Authorization');
  return authorization
    ?.match(/\bToken=(?:"([^"]+)"|([^,\s]+))/i)
    ?.slice(1)
    .find(Boolean);
}

function defaultUserData(itemId: string | undefined) {
  return {
    PlaybackPositionTicks: 0,
    PlayCount: 0,
    IsFavorite: false,
    Played: false,
    Key: itemId,
  };
}

function serverInfo() {
  return {
    LocalAddress: `${appConfig.bootstrap.baseUrl.replace(/\/+$/, '')}/jellyfin`,
    ServerName: `${appConfig.branding.addonName} Jellyfin`,
    Version: JELLYFIN_COMPATIBILITY_VERSION,
    ProductName: 'AIOStreams Jellyfin Player API',
    OperatingSystem: process.platform,
    Id: serverId(),
    StartupWizardCompleted: true,
  };
}

function userDto(uuid: string, name: string) {
  return {
    Name: name,
    ServerId: serverId(),
    Id: getSimpleTextHash(`aiostreams-jellyfin-user:${uuid}`).slice(0, 32),
    HasPassword: true,
    HasConfiguredPassword: true,
    EnableAutoLogin: false,
    Configuration: {
      PlayDefaultAudioTrack: true,
      SubtitleLanguagePreference: '',
      DisplayMissingEpisodes: false,
      GroupedFolders: [],
      SubtitleMode: 'Default',
      DisplayCollectionsView: false,
      EnableLocalPassword: false,
      OrderedViews: [],
      LatestItemsExcludes: [],
      MyMediaExcludes: [],
      HidePlayedInLatest: true,
      RememberAudioSelections: true,
      RememberSubtitleSelections: true,
      EnableNextEpisodeAutoPlay: true,
    },
    Policy: {
      IsAdministrator: false,
      IsHidden: false,
      IsDisabled: false,
      EnableCollectionManagement: false,
      EnableSubtitleManagement: false,
      EnableLyricManagement: false,
      IsTagBlockingModeInclusive: false,
      BlockedTags: [],
      AllowedTags: [],
      EnableUserPreferenceAccess: true,
      AccessSchedules: [],
      BlockUnratedItems: [],
      EnableRemoteControlOfOtherUsers: false,
      EnableSharedDeviceControl: false,
      EnableRemoteAccess: true,
      EnableLiveTvManagement: false,
      EnableLiveTvAccess: false,
      EnableMediaPlayback: true,
      EnableAudioPlaybackTranscoding: false,
      EnableVideoPlaybackTranscoding: false,
      EnablePlaybackRemuxing: false,
      ForceRemoteSourceTranscoding: false,
      EnableContentDeletion: false,
      EnableContentDownloading: false,
      EnableSyncTranscoding: false,
      EnableMediaConversion: false,
      EnabledDevices: [],
      EnableAllDevices: true,
      EnabledChannels: [],
      EnableAllChannels: true,
      EnabledFolders: [],
      EnableAllFolders: true,
      InvalidLoginAttemptCount: 0,
      LoginAttemptsBeforeLockout: -1,
      MaxActiveSessions: 0,
      EnablePublicSharing: false,
      BlockedMediaFolders: [],
      BlockedChannels: [],
      RemoteClientBitrateLimit: 0,
      AuthenticationProviderId:
        'Jellyfin.Server.Implementations.Users.DefaultAuthenticationProvider',
      PasswordResetProviderId:
        'Jellyfin.Server.Implementations.Users.DefaultPasswordResetProvider',
      SyncPlayAccess: 'None',
    },
  };
}

function serverId(): string {
  return getSimpleTextHash(
    `aiostreams-jellyfin:${appConfig.bootstrap.baseUrl}`
  ).slice(0, 32);
}

function requestClient(req: Request): string {
  return (
    req.get('X-Emby-Authorization')?.match(/\bClient="([^"]+)"/i)?.[1] ??
    'Jellyfin Client'
  );
}

function requestDevice(req: Request): string {
  return (
    req.get('X-Emby-Authorization')?.match(/\bDevice="([^"]+)"/i)?.[1] ??
    'Unknown Device'
  );
}

function bodyString(req: Request, key: string): string | undefined {
  const value = (req.body as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function queryString(req: Request, key: string): string | undefined {
  return queryStrings(req, key)[0];
}

function queryStrings(req: Request, key: string): string[] {
  const found = Object.entries(req.query).find(
    ([candidate]) => candidate.toLowerCase() === key.toLowerCase()
  )?.[1];
  if (typeof found === 'string') return [found];
  if (Array.isArray(found))
    return found.filter((value): value is string => typeof value === 'string');
  return [];
}

function httpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function pathParameter(req: Request, key: string): string | undefined {
  const value = req.params[key];
  return typeof value === 'string' ? value : value?.[0];
}

function problem(res: Response, status: number, detail: string): void {
  res.status(status).json({
    type: 'about:blank',
    title: status === 401 ? 'Unauthorized' : 'Jellyfin API error',
    status,
    detail,
  });
}

export default createJellyfinRouter();
