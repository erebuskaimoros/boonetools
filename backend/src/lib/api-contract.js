export const API_SCHEMA_VERSION = 2;
export const API_V2_MEDIA_TYPE = 'application/vnd.boonetools.v2+json';

function headerValue(request, name) {
  const normalized = name.toLowerCase();
  return String(
    request?.headers?.[normalized]
      ?? request?.headers?.get?.(name)
      ?? ''
  );
}

function normalizeTimestamp(value, fallback) {
  if (value == null || value === '') return fallback;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : fallback;
}

function normalizeWarnings(body) {
  const values = [
    ...(Array.isArray(body?.warnings) ? body.warnings : []),
    ...(Array.isArray(body?.meta?.warnings) ? body.meta.warnings : []),
    body?.warning,
    body?.meta?.warning
  ];
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function inferAsOf(body, now) {
  const candidates = [
    body?.meta?.asOf,
    body?.meta?.as_of,
    body?.asOf,
    body?.as_of,
    body?.generatedAt,
    body?.generated_at,
    body?.updatedAt,
    body?.updated_at,
    body?.fetchedAt,
    body?.fetched_at
  ];
  const first = candidates.find((value) => value != null && value !== '');
  return normalizeTimestamp(first, now);
}

function inferSource(body, route) {
  const source = body?.meta?.source ?? body?.source ?? body?.source_name;
  if (Array.isArray(source)) return source.map(String);
  if (source && typeof source === 'object') return source;
  return String(source || route || 'boonetools');
}

export function wantsApiSchemaV2(request, url) {
  const queryVersion = String(url?.searchParams?.get?.('schema_version') || '');
  if (queryVersion === String(API_SCHEMA_VERSION)) return true;
  const accept = headerValue(request, 'accept').toLowerCase();
  return accept.includes(API_V2_MEDIA_TYPE);
}

export function createApiMeta(body, options = {}) {
  const now = normalizeTimestamp(options.now || new Date().toISOString(), new Date().toISOString());
  const existingMeta = body?.meta && typeof body.meta === 'object' && !Array.isArray(body.meta)
    ? body.meta
    : {};
  const provenance = existingMeta.provenance
    ?? body?.provenance
    ?? body?.source_provenance
    ?? { endpoint: options.route || '' };

  return {
    ...existingMeta,
    schemaVersion: API_SCHEMA_VERSION,
    asOf: inferAsOf(body, now),
    source: inferSource(body, options.route),
    provenance,
    stale: Boolean(existingMeta.stale ?? body?.stale),
    warnings: normalizeWarnings(body)
  };
}

export function applyApiContract(result, options = {}) {
  if (!result || Number(result.status || 200) >= 400) return result;
  const body = result.body;
  if (body == null || typeof body !== 'object') return result;

  const meta = createApiMeta(body, options);
  const versioned = wantsApiSchemaV2(options.request, options.url);
  let contractedBody;

  if (versioned) {
    if (Array.isArray(body)) {
      contractedBody = { data: body, meta };
    } else {
      const { meta: _legacyMeta, ...data } = body;
      contractedBody = { data, meta };
    }
  } else if (Array.isArray(body)) {
    contractedBody = body;
  } else {
    contractedBody = {
      ...body,
      meta
    };
  }

  return {
    ...result,
    body: contractedBody,
    headers: {
      ...result.headers,
      ...(versioned ? { 'Content-Type': API_V2_MEDIA_TYPE } : {}),
      'X-Boone-Schema-Version': String(API_SCHEMA_VERSION),
      Vary: result.headers?.Vary
        ? `${result.headers.Vary}, Accept`
        : 'Accept'
    }
  };
}
