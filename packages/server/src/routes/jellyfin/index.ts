import { Router, type Request, type Response } from 'express';
import {
  AIOStreams,
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

const logger = createLogger('jellyfin-api');
const SOURCE_TOKEN_TTL_SECONDS = 5 * 60;

export interface JellyfinApiDependencies {
  authenticate(username: string, password: string): Promise<{ uuid: string }>;
  loadUser(grant: JellyfinAccessGrant, ip?: string): Promise<UserData>;
  listStreams(
    userData: UserData,
    request: { type: 'movie' | 'series'; id: string }
  ): Promise<readonly ParsedStream[]>;
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

  router.get('/Items', async (req, res) => {
    const auth = await authenticated(req, res, dependencies);
    if (!auth) return;
    const identity = identityFromItemsQuery(req);
    const items = identity ? [jellyfinItemDto(identity)] : [];
    res.status(200).json({
      Items: items,
      TotalRecordCount: items.length,
      StartIndex: 0,
    });
  });

  router.get('/Items/:itemId', async (req, res) => {
    const auth = await authenticated(req, res, dependencies);
    if (!auth) return;
    const identity = decodeJellyfinItemId(req.params.itemId);
    if (!identity) {
      problem(res, 404, 'Item not found');
      return;
    }
    res.status(200).json(jellyfinItemDto(identity));
  });

  router.post('/Items/:itemId/PlaybackInfo', async (req, res) => {
    const auth = await authenticated(req, res, dependencies);
    if (!auth) return;
    const identity = decodeJellyfinItemId(req.params.itemId);
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
  });

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

function requestAccessToken(req: Request): string | undefined {
  const direct = req.get('X-Emby-Token') ?? req.get('X-MediaBrowser-Token');
  if (direct) return direct;
  const query = queryString(req, 'api_key');
  if (query) return query;
  const authorization = req.get('Authorization');
  return authorization
    ?.match(/\bToken=(?:"([^"]+)"|([^,\s]+))/i)
    ?.slice(1)
    .find(Boolean);
}

function serverInfo() {
  return {
    LocalAddress: `${appConfig.bootstrap.baseUrl.replace(/\/+$/, '')}/jellyfin`,
    ServerName: `${appConfig.branding.addonName} Jellyfin`,
    Version: appConfig.bootstrap.version,
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
    Policy: { IsAdministrator: false, IsDisabled: false },
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
  const direct = req.query[key];
  if (typeof direct === 'string') return direct;
  const found = Object.entries(req.query).find(
    ([candidate]) => candidate.toLowerCase() === key.toLowerCase()
  )?.[1];
  return typeof found === 'string' ? found : undefined;
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
