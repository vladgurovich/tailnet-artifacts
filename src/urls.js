// The single place that builds artifact links.
// Today content is served from the app origin and isolated with the CSP sandbox
// header. Setting `contentOrigin` moves raw version content to a separate origin
// without touching any other code.

export function makeUrls(cfg) {
  return function urlsFor(req) {
    const app = cfg.publicUrl || originFromRequest(req);
    const content = cfg.contentOrigin || app;
    const enc = encodeURIComponent;
    return {
      app,
      gallery: () => `${app}/`,
      artifact: (id) => `${app}/a/${enc(id)}/`,
      info: (id) => `${app}/a/${enc(id)}/info`,
      viewVersion: (id, n) => `${app}/a/${enc(id)}/?v=${n}`,
      // Raw content (untrusted). Always sandboxed.
      version: (id, n) => `${content}/a/${enc(id)}/v/${n}/`,
      file: (id, n, path) => `${content}/a/${enc(id)}/v/${n}/${path.split('/').map(enc).join('/')}`,
    };
  };
}

function originFromRequest(req) {
  if (!req) return '';
  const proto = first(req.headers['x-forwarded-proto']) || (req.socket?.encrypted ? 'https' : 'http');
  const host = first(req.headers['x-forwarded-host']) || req.headers.host || 'localhost';
  return `${proto}://${host}`;
}

function first(v) {
  return (Array.isArray(v) ? v[0] : v)?.split(',')[0].trim();
}
