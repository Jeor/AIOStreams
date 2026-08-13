import { Buffer } from 'node:buffer';

export type JellyfinIdentityKind = 'movie' | 'series' | 'episode';
export type JellyfinIdentityProvider = 'imdb' | 'tmdb' | 'tvdb' | 'mal';

export interface JellyfinMediaIdentity {
  kind: JellyfinIdentityKind;
  provider: JellyfinIdentityProvider;
  externalId: string;
  season?: number;
  episode?: number;
}

const MAGIC = Buffer.from('AIOJ', 'ascii');
const VERSION = 1;
const ABSENT_EPISODE_NUMBER = 0xffff;
const MAX_EXTERNAL_NUMBER = 0xffffffffff;

const kindCodes: Record<JellyfinIdentityKind, number> = {
  movie: 1,
  series: 2,
  episode: 3,
};

const providerCodes: Record<JellyfinIdentityProvider, number> = {
  imdb: 1,
  tmdb: 2,
  tvdb: 3,
  mal: 4,
};

export function encodeJellyfinItemId(identity: JellyfinMediaIdentity): string {
  const normalized = normalizeIdentity(identity);
  const numericId = externalNumber(normalized.provider, normalized.externalId);
  if (numericId > MAX_EXTERNAL_NUMBER) {
    throw new Error('External identifier is too large');
  }

  const bytes = Buffer.alloc(16);
  MAGIC.copy(bytes, 0);
  bytes[4] = VERSION;
  bytes[5] = kindCodes[normalized.kind];
  const identifierWidth = externalDigits(
    normalized.provider,
    normalized.externalId
  ).length;
  bytes[6] = (identifierWidth << 4) | providerCodes[normalized.provider];
  bytes.writeUIntBE(numericId, 7, 5);
  bytes.writeUInt16BE(normalized.season ?? ABSENT_EPISODE_NUMBER, 12);
  bytes.writeUInt16BE(normalized.episode ?? ABSENT_EPISODE_NUMBER, 14);
  return bytes.toString('hex');
}

export function decodeJellyfinItemId(
  value: string
): JellyfinMediaIdentity | null {
  const alias = decodePlayerAlias(value);
  if (alias) return alias;

  const compact = value.replaceAll('-', '').toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(compact)) return null;
  const bytes = Buffer.from(compact, 'hex');
  if (!bytes.subarray(0, 4).equals(MAGIC) || bytes[4] !== VERSION) return null;

  const kind = codeKey(kindCodes, bytes[5]);
  const identifierWidth = (bytes[6] ?? 0) >> 4;
  const provider = codeKey(providerCodes, (bytes[6] ?? 0) & 0x0f);
  if (!kind || !provider) return null;
  const numericId = bytes.readUIntBE(7, 5);
  const seasonRaw = bytes.readUInt16BE(12);
  const episodeRaw = bytes.readUInt16BE(14);
  const externalId = formatExternalId(provider, numericId, identifierWidth);

  if (kind === 'episode') {
    if (
      seasonRaw === ABSENT_EPISODE_NUMBER ||
      episodeRaw === ABSENT_EPISODE_NUMBER
    ) {
      return null;
    }
    return {
      kind,
      provider,
      externalId,
      season: seasonRaw,
      episode: episodeRaw,
    };
  }
  if (
    seasonRaw !== ABSENT_EPISODE_NUMBER ||
    episodeRaw !== ABSENT_EPISODE_NUMBER
  ) {
    return null;
  }
  return { kind, provider, externalId };
}

export function identityToStremioRequest(identity: JellyfinMediaIdentity): {
  type: 'movie' | 'series';
  id: string;
} | null {
  const normalized = normalizeIdentity(identity);
  const base =
    normalized.provider === 'imdb'
      ? normalized.externalId
      : `${normalized.provider}:${normalized.externalId}`;
  if (normalized.kind === 'movie') return { type: 'movie', id: base };
  if (normalized.kind !== 'episode') return null;
  return {
    type: 'series',
    id: `${base}:${normalized.season}:${normalized.episode}`,
  };
}

export function parseExternalIdentity(input: {
  kind: string;
  provider: string;
  externalId: string;
  season?: string | number;
  episode?: string | number;
}): JellyfinMediaIdentity | null {
  const kind = input.kind.trim().toLowerCase();
  const provider = input.provider.trim().toLowerCase();
  if (!isKind(kind) || !isProvider(provider)) return null;
  const season = optionalEpisodeNumber(input.season);
  const episode = optionalEpisodeNumber(input.episode);
  try {
    return normalizeIdentity({
      kind,
      provider,
      externalId: input.externalId,
      ...(season === undefined ? {} : { season }),
      ...(episode === undefined ? {} : { episode }),
    });
  } catch {
    return null;
  }
}

export function jellyfinItemDto(identity: JellyfinMediaIdentity) {
  const normalized = normalizeIdentity(identity);
  const providerName = providerDisplayName(normalized.provider);
  const episodeSuffix =
    normalized.kind === 'episode'
      ? ` S${String(normalized.season).padStart(2, '0')}E${String(
          normalized.episode
        ).padStart(2, '0')}`
      : '';
  return {
    Name: `${providerName} ${normalized.externalId}${episodeSuffix}`,
    Id: encodeJellyfinItemId(normalized),
    Type:
      normalized.kind === 'movie'
        ? 'Movie'
        : normalized.kind === 'series'
          ? 'Series'
          : 'Episode',
    IsFolder: normalized.kind === 'series',
    LocationType: 'Virtual',
    ProviderIds: { [providerName]: normalized.externalId },
    ...(normalized.kind === 'episode'
      ? {
          ParentIndexNumber: normalized.season,
          IndexNumber: normalized.episode,
        }
      : {}),
  };
}

function decodePlayerAlias(value: string): JellyfinMediaIdentity | null {
  const parts = value.split(':');
  if (parts.length !== 3 && parts.length !== 5) return null;
  return parseExternalIdentity({
    kind: parts[0] ?? '',
    provider: parts[1] ?? '',
    externalId: parts[2] ?? '',
    ...(parts.length === 5 ? { season: parts[3], episode: parts[4] } : {}),
  });
}

function normalizeIdentity(
  identity: JellyfinMediaIdentity
): JellyfinMediaIdentity {
  const prefix =
    identity.provider === 'imdb'
      ? /^(?:tt|imdb[:-]?)/i
      : new RegExp(`^${identity.provider}[:-]?`, 'i');
  const digits = identity.externalId.trim().replace(prefix, '');
  if (!/^\d{1,12}$/.test(digits))
    throw new Error('External identifier is invalid');
  const numericId = Number(digits);
  if (!Number.isSafeInteger(numericId) || numericId < 0) {
    throw new Error('External identifier is invalid');
  }
  if (identity.kind === 'episode') {
    if (
      !validEpisodeNumber(identity.season) ||
      !validEpisodeNumber(identity.episode)
    ) {
      throw new Error('Episode identity is invalid');
    }
  } else if (identity.season !== undefined || identity.episode !== undefined) {
    throw new Error('Media identity is invalid');
  }
  return {
    kind: identity.kind,
    provider: identity.provider,
    externalId: identity.provider === 'imdb' ? `tt${digits}` : digits,
    ...(identity.kind === 'episode'
      ? { season: identity.season, episode: identity.episode }
      : {}),
  };
}

function externalNumber(
  provider: JellyfinIdentityProvider,
  externalId: string
): number {
  return Number(
    provider === 'imdb' ? externalId.replace(/^tt/i, '') : externalId
  );
}

function externalDigits(
  provider: JellyfinIdentityProvider,
  externalId: string
): string {
  return provider === 'imdb' ? externalId.replace(/^tt/i, '') : externalId;
}

function formatExternalId(
  provider: JellyfinIdentityProvider,
  value: number,
  width: number = 0
): string {
  const digits = String(value).padStart(width, '0');
  return provider === 'imdb' ? `tt${digits}` : digits;
}

function providerDisplayName(provider: JellyfinIdentityProvider): string {
  if (provider === 'imdb') return 'Imdb';
  if (provider === 'tmdb') return 'Tmdb';
  if (provider === 'tvdb') return 'Tvdb';
  return 'Mal';
}

function optionalEpisodeNumber(
  value: string | number | undefined
): number | undefined {
  if (value === undefined || value === '') return undefined;
  const number = typeof value === 'number' ? value : Number(value);
  return validEpisodeNumber(number) ? number : undefined;
}

function validEpisodeNumber(value: number | undefined): value is number {
  return (
    Number.isInteger(value) &&
    (value ?? -1) >= 0 &&
    (value ?? 0) < ABSENT_EPISODE_NUMBER
  );
}

function isKind(value: string): value is JellyfinIdentityKind {
  return value === 'movie' || value === 'series' || value === 'episode';
}

function isProvider(value: string): value is JellyfinIdentityProvider {
  return (
    value === 'imdb' || value === 'tmdb' || value === 'tvdb' || value === 'mal'
  );
}

function codeKey<T extends string>(
  map: Record<T, number>,
  code: number | undefined
): T | null {
  return (
    (Object.entries(map).find(([, value]) => value === code)?.[0] as
      | T
      | undefined) ?? null
  );
}
