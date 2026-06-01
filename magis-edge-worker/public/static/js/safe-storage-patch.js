// public/static/js/safe-storage-patch.js
// Patches window.localStorage, sessionStorage, and document.cookie
// so they fall back to in-memory stores if blocked.

;(function() {
    const memoryStore = {
      local:   Object.create(null),
      session: Object.create(null),
      cookie:  Object.create(null)
    };
  
    // Capture real storage if available
    let realLocal, realSession;
    try { realLocal   = window.localStorage;   } catch {}
    try { realSession = window.sessionStorage; } catch {}
  
    // Factory for safe storage wrappers
    function makeSafeStorage(orig, fallback) {
      return {
        get length() {
          try { return orig.length; }
          catch { return Object.keys(fallback).length; }
        },
        key(i) {
          try { return orig.key(i); }
          catch { return Object.keys(fallback)[i] || null; }
        },
        getItem(k) {
          try {
            const v = orig.getItem(k);
            return v === null ? null : v;
          } catch {
            return fallback[k] ?? null;
          }
        },
        setItem(k, v) {
          try { orig.setItem(k, v); }
          catch { fallback[k] = String(v); }
        },
        removeItem(k) {
          try { orig.removeItem(k); }
          catch { delete fallback[k]; }
        },
        clear() {
          try { orig.clear(); }
          catch { Object.keys(fallback).forEach(k => delete fallback[k]); }
        }
      };
    }
  
    // Override global storages
    Object.defineProperty(window, 'localStorage', {
      configurable: true, enumerable: true,
      get() { return makeSafeStorage(realLocal || {}, memoryStore.local); }
    });
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true, enumerable: true,
      get() { return makeSafeStorage(realSession || {}, memoryStore.session); }
    });
  
    // Safe‐cookie helper
    const safeCookie = {
      get(name) {
        try {
          const pairs = document.cookie ? document.cookie.split('; ') : [];
          for (const p of pairs) {
            const idx = p.indexOf('=');
            if (idx > 0 && p.slice(0, idx) === name) {
              return decodeURIComponent(p.slice(idx + 1));
            }
          }
        } catch {}
        return memoryStore.cookie[name] ?? null;
      },
      set(name, val, opts = {}) {
        const parts = [`${name}=${encodeURIComponent(val)}`];
        if (opts.maxAge)   parts.push(`Max-Age=${opts.maxAge}`);
        if (opts.expires)  parts.push(`Expires=${opts.expires.toUTCString()}`);
        if (opts.path)     parts.push(`Path=${opts.path}`);
        if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
        if (opts.secure)   parts.push(`Secure`);
        const str = parts.join('; ');
        try { document.cookie = str; }
        catch { memoryStore.cookie[name] = String(val); }
      },
      remove(name, opts = {}) {
        this.set(name, '', { ...opts, expires: new Date(0) });
        delete memoryStore.cookie[name];
      },
      getAll() {
        const out = {};
        try {
          const pairs = document.cookie ? document.cookie.split('; ') : [];
          for (const p of pairs) {
            const idx = p.indexOf('=');
            if (idx > 0) {
              out[p.slice(0, idx)] = decodeURIComponent(p.slice(idx + 1));
            }
          }
        } catch {
          Object.assign(out, memoryStore.cookie);
        }
        return out;
      }
    };
  
    Object.defineProperty(window, 'cookie', {
      configurable: true, enumerable: true,
      get() { return safeCookie.getAll(); },
    });
  
    window.MagisSafe = {
      local:   makeSafeStorage(realLocal || {}, memoryStore.local),
      session: makeSafeStorage(realSession || {}, memoryStore.session),
      cookie:  safeCookie
    };
  })();
  