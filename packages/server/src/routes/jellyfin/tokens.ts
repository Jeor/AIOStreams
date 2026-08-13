import {
  decodeSignedPayload,
  decryptString,
  encodeSignedPayload,
  encryptString,
} from '@aiostreams/core';

interface AccessTokenPayload {
  k: 'jellyfin-access';
  u: string;
  p: string;
  exp: number;
}

interface SourceTokenPayload {
  k: 'jellyfin-source';
  u: string;
  i: string;
  s: string;
  exp: number;
}

export interface JellyfinAccessGrant {
  uuid: string;
  password: string;
}

export function issueJellyfinAccessToken(
  uuid: string,
  password: string,
  ttlSeconds: number,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): string {
  const encrypted = encryptString(password);
  if (!encrypted.success)
    throw new Error('Unable to issue Jellyfin access token');
  return encodeSignedPayload({
    k: 'jellyfin-access',
    u: uuid,
    p: encrypted.data,
    exp: nowSeconds + ttlSeconds,
  } satisfies AccessTokenPayload);
}

export function readJellyfinAccessToken(
  token: string | undefined,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): JellyfinAccessGrant | null {
  const payload = decodeSignedPayload<AccessTokenPayload>(token);
  if (
    payload?.k !== 'jellyfin-access' ||
    typeof payload.u !== 'string' ||
    typeof payload.p !== 'string' ||
    typeof payload.exp !== 'number' ||
    payload.exp <= nowSeconds
  ) {
    return null;
  }
  const decrypted = decryptString(payload.p);
  return decrypted.success
    ? { uuid: payload.u, password: decrypted.data }
    : null;
}

export function issueJellyfinSourceToken(
  uuid: string,
  itemId: string,
  sourceUrl: string,
  ttlSeconds: number,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): string {
  const encrypted = encryptString(sourceUrl);
  if (!encrypted.success)
    throw new Error('Unable to issue Jellyfin source token');
  return encodeSignedPayload({
    k: 'jellyfin-source',
    u: uuid,
    i: itemId,
    s: encrypted.data,
    exp: nowSeconds + ttlSeconds,
  } satisfies SourceTokenPayload);
}

export function readJellyfinSourceToken(
  token: string | undefined,
  itemId: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): { uuid: string; sourceUrl: string } | null {
  const payload = decodeSignedPayload<SourceTokenPayload>(token);
  if (
    payload?.k !== 'jellyfin-source' ||
    typeof payload.u !== 'string' ||
    payload.i !== itemId ||
    typeof payload.s !== 'string' ||
    typeof payload.exp !== 'number' ||
    payload.exp <= nowSeconds
  ) {
    return null;
  }
  const decrypted = decryptString(payload.s);
  return decrypted.success
    ? { uuid: payload.u, sourceUrl: decrypted.data }
    : null;
}
