const PAGE_VIEW_PREFIX = '/_analytics/page-view';
const PAGE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function buildPageViewEndpoint(appPath, basePath = '') {
  const slug = String(appPath || '').trim().toLowerCase();
  if (!PAGE_SLUG_PATTERN.test(slug)) return null;

  const normalizedBase = String(basePath || '')
    .trim()
    .replace(/\/+$/, '');

  return `${normalizedBase}${PAGE_VIEW_PREFIX}/${encodeURIComponent(slug)}`;
}

export function isDoNotTrackEnabled(navigatorRef = globalThis.navigator) {
  const value = navigatorRef?.doNotTrack;
  return value === '1' || String(value).toLowerCase() === 'yes';
}

export function trackFirstPartyPageView(appPath, {
  basePath = '',
  isDesktopApp = false,
  navigatorRef = globalThis.navigator,
  fetchRef = globalThis.fetch
} = {}) {
  if (isDesktopApp || isDoNotTrackEnabled(navigatorRef) || typeof fetchRef !== 'function') {
    return false;
  }

  const endpoint = buildPageViewEndpoint(appPath, basePath);
  if (!endpoint) return false;

  void fetchRef(endpoint, {
    method: 'POST',
    credentials: 'omit',
    cache: 'no-store',
    keepalive: true,
    referrerPolicy: 'no-referrer'
  }).catch(() => {
    // Analytics must never affect navigation or surface errors to visitors.
  });

  return true;
}
