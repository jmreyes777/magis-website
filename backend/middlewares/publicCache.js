// middlewares/publicCache.js
//
// PERF1-3: emit short-lived Cache-Control on PUBLIC, non-personalized GET
// responses so the browser and (Phase 5) the edge can serve repeat reads
// without hitting the origin.
//
// Security-preservation:
//  - Apply ONLY to non-authenticated, non-personalized endpoints. Never mount
//    on anything behind authenticate*/verifyAdminRole — caching a personalized
//    body in a shared cache would cross-pollute users.
//  - Only 2xx GET responses are marked cacheable. Errors/redirects get
//    `no-store` so a transient upstream failure is never cached.
//  - `Vary: Origin` is appended because CORS reflects the caller's Origin
//    (Access-Control-Allow-Origin), so a shared cache must key per-origin.
//    res.vary() merges with compression's `Vary: Accept-Encoding`.
module.exports = function publicCache(maxAgeSec, sMaxAgeSec) {
  const maxAge = Number(maxAgeSec) || 0;
  const sMaxAge = Number(sMaxAgeSec) || maxAge;
  const value = `public, max-age=${maxAge}, s-maxage=${sMaxAge}`;

  return function publicCacheMiddleware(req, res, next) {
    const origJson = res.json.bind(res);
    res.json = (body) => {
      const ok = req.method === "GET" && res.statusCode >= 200 && res.statusCode < 300;
      if (ok) {
        res.set("Cache-Control", value);
        res.vary("Origin");
      } else if (!res.getHeader("Cache-Control")) {
        res.set("Cache-Control", "no-store");
      }
      return origJson(body);
    };
    next();
  };
};
