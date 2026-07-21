// admin-frontend/src/pages/Observability-Page.js
//
// OBS6 (observability megaplan): super-admin Observability dashboard.
// Read-only view over GET /api/obs/summary:
//   - live backend snapshot (uptime, memory, Redis, version),
//   - uptime incidents recorded by the edge watchdog (obsIncidents),
//   - Web Vitals daily pass-rates from the RUM rollups (rumDaily),
//   - recent client-side errors from the guest site (clientErrors).
// Follows the Audit-Dashboard-Page conventions (admin-card, AdminNavigation,
// sessionStorage superAdminToken); no new dependencies.

import React, { useState, useEffect, useContext, useCallback } from "react";
import AdminNavigation from "../components/AdminNavigation-Component";
import AdminHeaderWidgets from "../components/AdminHeaderWidgets-Component";
import AuthContext from "../context/AuthContext";

const API = process.env.REACT_APP_API_URL || "";

// Mirror of backend/routes/rum.js BUCKETS — used to label the p75 estimate.
const BUCKET_EDGES = {
  LCP: [1000, 2500, 4000],
  FCP: [1000, 1800, 3000],
  TTFB: [200, 800, 1800],
  INP: [200, 500],
  CLS: [0.1, 0.25],
  SCT: [500, 1500, 3000],
};
const CORE_METRICS = ["LCP", "INP", "CLS"];
const EXTRA_METRICS = ["FCP", "TTFB", "SCT"];

const TYPE_BADGE = {
  error: "bg-red-100 text-red-800",
  rejection: "bg-orange-100 text-orange-800",
  boundary: "bg-purple-100 text-purple-800",
  hydration: "bg-amber-100 text-amber-800",
  recoverable: "bg-blue-100 text-blue-800",
};

const fmtTime = (ts) => {
  try { return new Date(ts).toLocaleString(); } catch { return ts || "—"; }
};

const fmtUptime = (sec) => {
  if (sec == null) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
};

const fmtEdge = (metric, edge) =>
  metric === "CLS" ? String(edge) : edge >= 1000 ? `${edge / 1000}s` : `${edge}ms`;

// %good among rated beacons (good/ni/poor). Rollup `count` includes unrated.
function passRate(c) {
  if (!c) return null;
  const rated = (c.good || 0) + (c.ni || 0) + (c.poor || 0);
  if (rated === 0) return null;
  return Math.round((100 * (c.good || 0)) / rated);
}

// Smallest histogram bucket whose cumulative share reaches 75% of samples.
function p75Label(metric, c) {
  if (!c || !c.count) return "—";
  const edges = BUCKET_EDGES[metric] || [];
  let cum = 0;
  for (let i = 0; i <= edges.length; i++) {
    cum += c[`b${i}`] || 0;
    if (cum >= 0.75 * c.count) {
      return i < edges.length ? `≤ ${fmtEdge(metric, edges[i])}` : `> ${fmtEdge(metric, edges[edges.length - 1])}`;
    }
  }
  return "—";
}

const rateColor = (pct) =>
  pct == null ? "text-gray-400" : pct >= 90 ? "text-green-600" : pct >= 75 ? "text-amber-600" : "text-red-600";

function Observability() {
  const { handleLogout } = useContext(AuthContext);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showExtra, setShowExtra] = useState(false);

  const fetchSummary = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = sessionStorage.getItem("superAdminToken");
      const res = await fetch(`${API}/api/obs/summary`, {
        headers: {
          "Content-Type": "application/json",
          ...(token && { Authorization: `Bearer ${token}` }),
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
    } catch (e) {
      console.warn("[OBS] summary fetch failed:", e.message);
      setError(`Could not load observability data (${e.message}).`);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchSummary(); }, [fetchSummary]);

  const health = data?.health || null;
  const incidents = data?.incidents || [];
  const rumDays = data?.rumDaily || [];
  const errors = data?.clientErrors || [];
  const metrics = showExtra ? [...CORE_METRICS, ...EXTRA_METRICS] : CORE_METRICS;

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <div className="w-full bg-gray-800 text-white p-4 flex justify-between items-center">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-semibold">Observability</h1>
          <AdminNavigation currentPage="/admin/observability" />
        </div>
        <div className="flex items-center gap-3">
          <AdminHeaderWidgets />
          <button onClick={handleLogout} className="btn btn-primary">Logout</button>
        </div>
      </div>

      <div className="flex flex-row flex-grow bg-gray-100">
        <div className="w-full p-6 overflow-y-auto">
          <div className="mb-4 flex items-center justify-between">
            <span className="text-sm text-gray-600">
              Live site health, uptime incidents, Web Vitals and client errors.
              {data?.at && <span className="text-gray-400"> · Snapshot {fmtTime(data.at)}</span>}
            </span>
            <button className="btn btn-primary" onClick={fetchSummary} disabled={loading}>
              {loading ? "Refreshing…" : "Refresh"}
            </button>
          </div>

          {error && (
            <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">{error}</div>
          )}

          {/* Backend snapshot */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <div className="admin-card">
              <p className="text-sm font-medium text-gray-600">Backend</p>
              <p className={`text-3xl font-bold ${health?.status === "ok" ? "text-green-600" : "text-red-600"}`}>
                {health ? (health.status === "ok" ? "Up" : "Error") : "—"}
              </p>
              <p className="text-xs text-gray-500 mt-2">
                {health ? `up ${fmtUptime(health.uptimeSec)} · node ${health.node || "?"}${health.version ? ` · v${health.version}` : ""}` : ""}
              </p>
            </div>
            <div className="admin-card">
              <p className="text-sm font-medium text-gray-600">Redis</p>
              <p className={`text-3xl font-bold ${health?.redis === "ok" ? "text-green-600" : health?.redis === "off" ? "text-gray-500" : "text-red-600"}`}>
                {health?.redis ? health.redis.toUpperCase() : "—"}
              </p>
              <p className="text-xs text-gray-500 mt-2">rate limits · token revocation · alert throttles</p>
            </div>
            <div className="admin-card">
              <p className="text-sm font-medium text-gray-600">Memory (RSS)</p>
              <p className="text-3xl font-bold text-gray-900">{health?.rssMb != null ? `${health.rssMb} MB` : "—"}</p>
              <p className="text-xs text-gray-500 mt-2">Render instance resident set size</p>
            </div>
            <div className="admin-card">
              <p className="text-sm font-medium text-gray-600">Client errors (24h)</p>
              <p className={`text-3xl font-bold ${(data?.clientErrors24h || 0) > 0 ? "text-amber-600" : "text-green-600"}`}>
                {data?.clientErrors24h ?? "—"}
              </p>
              <p className="text-xs text-gray-500 mt-2">beacons from the guest site</p>
            </div>
            {/* BDR2 (backup & DR megaplan): daily snapshot freshness */}
            <div className="admin-card">
              <p className="text-sm font-medium text-gray-600">Backup</p>
              <p className={`text-3xl font-bold ${
                data?.backup?.ok && !data.backup.stale ? "text-green-600" : "text-red-600"
              }`}>
                {data?.backup ? (data.backup.ok ? (data.backup.stale ? "Stale" : "OK") : "Failed") : "None"}
              </p>
              <p className="text-xs text-gray-500 mt-2">
                {data?.backup
                  ? `${data.backup.date} · ${data.backup.docs} docs · ${Math.round((data.backup.gzBytes || 0) / 1024)} KB · ${data.backup.ageHours}h ago`
                  : "no snapshot recorded yet"}
              </p>
            </div>
          </div>

          {/* Uptime incidents */}
          <div className="admin-card mb-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-1">Uptime incidents</h3>
            <p className="text-sm text-gray-600 mb-4">
              Outage windows detected by the edge watchdog (checks every 5 min; an incident is recorded on recovery).
            </p>
            {incidents.length === 0 ? (
              <div className="text-center text-green-700 bg-green-50 rounded py-4">
                No incidents recorded{data ? " — the watchdog has seen no sustained outages." : "."}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-gray-500 uppercase">
                      <th className="py-2 pr-4">Target</th>
                      <th className="py-2 pr-4">Down since</th>
                      <th className="py-2 pr-4">Recovered</th>
                      <th className="py-2 pr-4">Duration</th>
                      <th className="py-2 pr-4">Failed checks</th>
                      <th className="py-2">Last error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {incidents.map((inc) => (
                      <tr key={inc.id} className="border-t border-gray-100">
                        <td className="py-2 pr-4 font-medium">{inc.target}</td>
                        <td className="py-2 pr-4">{fmtTime(inc.downSince)}</td>
                        <td className="py-2 pr-4">{fmtTime(inc.upAt)}</td>
                        <td className="py-2 pr-4">{inc.durationMin ? `${inc.durationMin} min` : "—"}</td>
                        <td className="py-2 pr-4">{inc.checksFailed ?? "—"}</td>
                        <td className="py-2 text-gray-500">{inc.lastError || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Web Vitals */}
          <div className="admin-card mb-6">
            <div className="flex justify-between items-center mb-1">
              <h3 className="text-lg font-semibold text-gray-900">Web Vitals — daily pass rate</h3>
              <label className="text-sm text-gray-600 flex items-center gap-2">
                <input type="checkbox" checked={showExtra} onChange={(e) => setShowExtra(e.target.checked)} />
                Show FCP / TTFB / SCT
              </label>
            </div>
            <p className="text-sm text-gray-600 mb-4">
              % of real-user beacons rated “good” (Asia/Manila days, last 14 days) with an estimated p75 bucket.
            </p>
            {rumDays.length === 0 ? (
              <div className="text-center text-gray-500 py-4">
                No rollups yet — data appears within ~5 minutes of the first RUM beacons after this deploy.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-gray-500 uppercase">
                      <th className="py-2 pr-4">Day</th>
                      {metrics.map((m) => <th key={m} className="py-2 pr-4">{m}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {rumDays.map((d) => (
                      <tr key={d.id} className="border-t border-gray-100">
                        <td className="py-2 pr-4 font-medium whitespace-nowrap">{d.day || d.id}</td>
                        {metrics.map((m) => {
                          const c = d[m];
                          const pct = passRate(c);
                          return (
                            <td key={m} className="py-2 pr-4 whitespace-nowrap">
                              {c ? (
                                <>
                                  <span className={`font-semibold ${rateColor(pct)}`}>
                                    {pct == null ? "n/a" : `${pct}%`}
                                  </span>
                                  <span className="text-xs text-gray-500"> · p75 {p75Label(m, c)} · n={c.count || 0}</span>
                                </>
                              ) : (
                                <span className="text-gray-400">—</span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Client errors */}
          <div className="admin-card mb-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-1">Recent client errors</h3>
            <p className="text-sm text-gray-600 mb-4">
              Latest {errors.length} error beacons from visitors’ browsers (deduped per session, retained {" "}
              {process.env.REACT_APP_CERR_RETENTION_DAYS || 30} days). “hydration” events indicate prerender drift.
            </p>
            {loading && !data ? (
              <div className="text-center text-gray-500 py-8">Loading…</div>
            ) : errors.length === 0 ? (
              <div className="text-center text-green-700 bg-green-50 rounded py-4">No client errors recorded.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-gray-500 uppercase">
                      <th className="py-2 pr-4">Time</th>
                      <th className="py-2 pr-4">Type</th>
                      <th className="py-2 pr-4">Message</th>
                      <th className="py-2 pr-4">Path</th>
                      <th className="py-2">Release</th>
                    </tr>
                  </thead>
                  <tbody>
                    {errors.map((ev) => (
                      <tr key={ev.id} className="border-t border-gray-100 align-top">
                        <td className="py-2 pr-4 whitespace-nowrap">{fmtTime(ev.at)}</td>
                        <td className="py-2 pr-4">
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${TYPE_BADGE[ev.type] || "bg-gray-100 text-gray-700"}`}>
                            {ev.type}
                          </span>
                        </td>
                        <td className="py-2 pr-4" style={{ maxWidth: 420 }}>
                          <div className="truncate" title={ev.message}>{ev.message}</div>
                          {(ev.stack || ev.detail) && (
                            <details className="mt-1">
                              <summary className="text-xs text-indigo-600 cursor-pointer">stack / detail</summary>
                              <pre className="text-xs bg-gray-50 rounded p-2 mt-1 whitespace-pre-wrap break-all">
                                {[ev.stack, ev.detail].filter(Boolean).join("\n---\n")}
                              </pre>
                            </details>
                          )}
                        </td>
                        <td className="py-2 pr-4">{ev.path}</td>
                        <td className="py-2 text-gray-500">{ev.release || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default Observability;
