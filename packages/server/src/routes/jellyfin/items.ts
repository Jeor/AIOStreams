import {
  config as appConfig,
  getSimpleTextHash,
  type Meta,
  type MetaPreview,
} from '@aiostreams/core';
import {
  encodeJellyfinItemId,
  jellyfinItemDto,
  parseExternalIdentity,
  type JellyfinIdentityKind,
  type JellyfinMediaIdentity,
} from './identity.js';

type MetadataRecord = Record<string, unknown>;

export function identityFromCatalogItem(
  meta: MetaPreview,
  kind: 'movie' | 'series'
): JellyfinMediaIdentity | null {
  const data = meta as MetadataRecord;
  const candidates: Array<[string, unknown]> = [
    ['imdb', data.imdb_id],
    ['imdb', data.imdbId],
    ['tmdb', data.tmdb_id],
    ['tmdb', data.tmdbId],
    ['tvdb', data.tvdb_id],
    ['tvdb', data.tvdbId],
    ['mal', data.mal_id],
    ['mal', data.malId],
  ];

  const id = meta.id.trim();
  if (/^(?:tt|imdb[:-]?)\d+$/i.test(id)) candidates.unshift(['imdb', id]);
  const prefixed = /^(imdb|tmdb|tvdb|mal):(.+)$/i.exec(id);
  if (prefixed) candidates.unshift([prefixed[1] ?? '', prefixed[2]]);

  for (const [provider, value] of candidates) {
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const identity = parseExternalIdentity({
      kind,
      provider,
      externalId: String(value),
    });
    if (identity) return identity;
  }
  return null;
}

export function jellyfinMetadataItem(
  identity: JellyfinMediaIdentity,
  metadata?: Meta | MetaPreview | null,
  options?: { seriesName?: string; parentId?: string }
) {
  const base = jellyfinItemDto(identity);
  const itemData = metadataForIdentity(identity, metadata);
  const name = itemName(identity, itemData, options?.seriesName);
  const overview = stringValue(itemData, 'description', 'overview');
  const release = stringValue(itemData, 'released', 'releaseInfo');
  const premiereDate = isoDate(release);
  const productionYear = yearValue(itemData, release);
  const poster = imageForMetadata(itemData, 'Primary');
  const backdrop = imageForMetadata(itemData, 'Backdrop');
  const id = encodeJellyfinItemId(identity);
  const parentIds = parentItemIds(identity);

  return {
    ...base,
    Name: name,
    ServerId: serverId(),
    ETag: getSimpleTextHash(`aiostreams-jellyfin-item:${id}:${name}`).slice(
      0,
      32
    ),
    DateCreated: premiereDate ?? '1970-01-01T00:00:00.000Z',
    CanDelete: false,
    CanDownload: false,
    SortName: name,
    ExternalUrls: [],
    Path: null,
    ChannelId: null,
    Taglines: [],
    Genres: arrayValue(itemData, 'genres', 'genre'),
    PlayAccess: 'Full',
    MediaType: identity.kind === 'season' ? undefined : 'Video',
    // Infuse excludes LocationType=Virtual from its standard Jellyfin search
    // and browse queries. These identities resolve through PlaybackInfo and are
    // playable server items, so they use Jellyfin's normal library item type.
    LocationType: 'FileSystem',
    MediaSources: [],
    MediaStreams: [],
    PartCount: 0,
    ImageTags: poster ? { Primary: imageTag(id, 'Primary', poster) } : {},
    BackdropImageTags: backdrop ? [imageTag(id, 'Backdrop', backdrop)] : [],
    ImageBlurHashes: {},
    Chapters: [],
    Trickplay: {},
    UserData: {
      PlaybackPositionTicks: 0,
      PlayCount: 0,
      IsFavorite: false,
      Played: false,
      Key: id,
    },
    ...(overview ? { Overview: overview } : {}),
    ...(premiereDate ? { PremiereDate: premiereDate } : {}),
    ...(productionYear ? { ProductionYear: productionYear } : {}),
    ...runtimeFields(itemData),
    ...ratingFields(itemData),
    ...parentIds,
    ...(options?.parentId ? { ParentId: options.parentId } : {}),
    ...(options?.seriesName ? { SeriesName: options.seriesName } : {}),
  };
}

export function seriesSeasons(
  seriesIdentity: JellyfinMediaIdentity,
  metadata: Meta | null
) {
  if (seriesIdentity.kind !== 'series') return [];
  const videos = metadata?.videos ?? [];
  const seasons = [
    ...new Set(
      videos
        .map((video) => video.season)
        .filter((value): value is number => Number.isInteger(value))
    ),
  ].sort((a, b) => a - b);
  return seasons.map((season) =>
    jellyfinMetadataItem(
      { ...seriesIdentity, kind: 'season', season },
      metadata
    )
  );
}

export function seriesEpisodes(
  seriesIdentity: JellyfinMediaIdentity,
  metadata: Meta | null,
  season?: number
) {
  if (seriesIdentity.kind !== 'series') return [];
  const seriesName = stringValue(metadata as MetadataRecord, 'name', 'title');
  return (metadata?.videos ?? [])
    .filter(
      (video) =>
        Number.isInteger(video.season) &&
        Number.isInteger(video.episode) &&
        (season === undefined || video.season === season)
    )
    .map((video) =>
      jellyfinMetadataItem(
        {
          ...seriesIdentity,
          kind: 'episode',
          season: video.season!,
          episode: video.episode!,
        },
        metadata,
        { seriesName }
      )
    );
}

export function imageForItem(
  identity: JellyfinMediaIdentity,
  metadata: Meta | null,
  imageType: string
): string | null {
  return imageForMetadata(metadataForIdentity(identity, metadata), imageType);
}

export function virtualViews(uuid: string) {
  return [
    virtualView(uuid, 'movies', 'AIOStreams Movie Search'),
    virtualView(uuid, 'tvshows', 'AIOStreams Series Search'),
  ];
}

export function isVirtualViewId(uuid: string, id: string): boolean {
  return virtualViews(uuid).some((view) => view.Id === id);
}

function virtualView(
  uuid: string,
  collectionType: 'movies' | 'tvshows',
  name: string
) {
  const id = getSimpleTextHash(
    `aiostreams-jellyfin-view:${uuid}:${collectionType}`
  ).slice(0, 32);
  return {
    Name: name,
    ServerId: serverId(),
    Id: id,
    ETag: id,
    DateCreated: '1970-01-01T00:00:00.000Z',
    CanDelete: false,
    CanDownload: false,
    SortName: name,
    ExternalUrls: [],
    Path: null,
    EnableMediaSourceDisplay: false,
    IsFolder: true,
    ParentId: null,
    Type: 'CollectionFolder',
    CollectionType: collectionType,
    LocationType: 'Virtual',
    ImageTags: {},
    BackdropImageTags: [],
    UserData: {
      PlaybackPositionTicks: 0,
      PlayCount: 0,
      IsFavorite: false,
      Played: false,
      Key: id,
    },
  };
}

function metadataForIdentity(
  identity: JellyfinMediaIdentity,
  metadata?: Meta | MetaPreview | null
): MetadataRecord {
  if (!metadata) return {};
  if (identity.kind !== 'episode') return metadata as MetadataRecord;
  const video = (metadata as Meta).videos?.find(
    (candidate) =>
      candidate.season === identity.season &&
      candidate.episode === identity.episode
  );
  return (video ?? metadata) as MetadataRecord;
}

function itemName(
  identity: JellyfinMediaIdentity,
  metadata: MetadataRecord,
  seriesName?: string
): string {
  if (identity.kind === 'season') return `Season ${identity.season}`;
  const fallback = jellyfinItemDto(identity).Name;
  const name = stringValue(metadata, 'name', 'title') || fallback;
  if (identity.kind !== 'episode') return name;
  return name || `${seriesName || 'Episode'} ${identity.episode}`;
}

function parentItemIds(identity: JellyfinMediaIdentity) {
  if (identity.kind === 'season') {
    const seriesId = encodeJellyfinItemId({
      ...identity,
      kind: 'series',
      season: undefined,
      episode: undefined,
    });
    return {
      SeriesId: seriesId,
      ParentId: seriesId,
    };
  }
  if (identity.kind === 'episode') {
    const seriesId = encodeJellyfinItemId({
      ...identity,
      kind: 'series',
      season: undefined,
      episode: undefined,
    });
    const seasonId = encodeJellyfinItemId({
      ...identity,
      kind: 'season',
      episode: undefined,
    });
    return { SeriesId: seriesId, SeasonId: seasonId, ParentId: seasonId };
  }
  return {};
}

function imageForMetadata(
  metadata: MetadataRecord,
  imageType: string
): string | null {
  if (imageType.toLowerCase() === 'backdrop') {
    return stringValue(metadata, 'background', 'thumbnail') || null;
  }
  if (imageType.toLowerCase() === 'logo') {
    return stringValue(metadata, 'logo') || null;
  }
  return stringValue(metadata, 'poster', 'thumbnail') || null;
}

function imageTag(id: string, type: string, url: string): string {
  return getSimpleTextHash(`${id}:${type}:${url}`).slice(0, 32);
}

function stringValue(
  data: MetadataRecord | null | undefined,
  ...keys: string[]
): string {
  if (!data) return '';
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return '';
}

function arrayValue(data: MetadataRecord, ...keys: string[]): string[] {
  for (const key of keys) {
    const value = data[key];
    if (Array.isArray(value))
      return value.filter((item): item is string => typeof item === 'string');
    if (typeof value === 'string' && value.trim()) return [value.trim()];
  }
  return [];
}

function isoDate(value: string): string | undefined {
  if (!value) return undefined;
  const match = /^\d{4}/.exec(value);
  const parsed = new Date(
    /^\d{4}$/.test(value) ? `${value}-01-01T00:00:00.000Z` : value
  );
  if (!Number.isNaN(parsed.valueOf())) return parsed.toISOString();
  if (match) return `${match[0]}-01-01T00:00:00.000Z`;
  return undefined;
}

function yearValue(data: MetadataRecord, release: string): number | undefined {
  const direct = data.year;
  if (typeof direct === 'number' && Number.isInteger(direct)) return direct;
  const match = /\b(18|19|20|21)\d{2}\b/.exec(release);
  return match ? Number(match[0]) : undefined;
}

function runtimeFields(data: MetadataRecord) {
  const value = stringValue(data, 'runtime');
  const minutes = Number.parseFloat(value);
  return Number.isFinite(minutes) && minutes > 0
    ? { RunTimeTicks: Math.round(minutes * 60 * 10_000_000) }
    : {};
}

function ratingFields(data: MetadataRecord) {
  const value = data.imdbRating ?? data.communityRating;
  const rating = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(rating) ? { CommunityRating: rating } : {};
}

function serverId(): string {
  return getSimpleTextHash(
    `aiostreams-jellyfin:${appConfig.bootstrap.baseUrl}`
  ).slice(0, 32);
}
