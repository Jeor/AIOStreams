export interface DirectStreamCandidate {
  url?: string;
  proxied?: boolean;
  requestHeaders?: Readonly<Record<string, string>>;
  responseHeaders?: Readonly<Record<string, string>>;
  parsedFile?: { container?: string; extension?: string };
}

export function directProviderUrl(
  stream: DirectStreamCandidate,
  aiostreamsBaseUrl: string
): string | null {
  if (
    !stream.url ||
    stream.proxied === true ||
    Object.keys(stream.requestHeaders ?? {}).length > 0 ||
    Object.keys(stream.responseHeaders ?? {}).length > 0
  ) {
    return null;
  }
  return safeExternalHttpUrl(stream.url, aiostreamsBaseUrl) ? stream.url : null;
}

export function safeExternalHttpUrl(
  value: string,
  aiostreamsBaseUrl: string
): boolean {
  try {
    const url = new URL(value);
    const own = new URL(aiostreamsBaseUrl);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.origin !== own.origin
    );
  } catch {
    return false;
  }
}

export function sourceContainer(
  stream: DirectStreamCandidate
): string | undefined {
  const declared = stream.parsedFile?.container ?? stream.parsedFile?.extension;
  if (declared && /^[a-z0-9]{2,8}$/i.test(declared)) {
    return declared.toLowerCase();
  }
  try {
    const match = new URL(stream.url ?? '').pathname.match(
      /\.([a-z0-9]{2,8})$/i
    );
    return match?.[1]?.toLowerCase();
  } catch {
    return undefined;
  }
}
