// magis-project/admin-frontend/src/pages/Admin-Page-Branch-Passwords.js
//
// Super-admin "password manager" for BRANCH logins. Lists every branch (from
// Firestore) and lets the super admin set/reset each branch's login password,
// which is written (scrypt-hashed) to the `branchAdmins` collection via
// /api/branch/admin/set-password. The branch then signs in with that email +
// password and an emailed OTP on every login.

import React, { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import axios from "axios";
import { collection, getDocs } from "firebase/firestore";
import { db } from "../firebase-config";

const api = axios.create({
  baseURL: process.env.REACT_APP_API_URL || "",
  withCredentials: true,
});

const authHeaders = () => ({
  Authorization: `Bearer ${sessionStorage.getItem("superAdminToken") || ""}`,
});

function BranchPasswords() {
  const navigate = useNavigate();

  const [branches, setBranches] = useState([]);
  const [credByEmail, setCredByEmail] = useState({});
  const [credByBranchId, setCredByBranchId] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pw, setPw] = useState({}); // branchId -> typed password
  const [show, setShow] = useState({}); // branchId -> reveal input
  const [busyId, setBusyId] = useState(null);
  const [mfaBusyId, setMfaBusyId] = useState(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const snap = await getDocs(collection(db, "branches"));
      // UAT F12: when Firestore is unreachable, getDocs RESOLVES from the
      // (empty) local cache instead of rejecting — the page then showed a
      // misleading "No branches found." with no error and no Try again.
      // A cache-only empty snapshot is an outage, not an empty collection.
      if (snap.metadata.fromCache && snap.empty) {
        throw new Error("cache-only empty snapshot (Firestore unreachable)");
      }
      const list = snap.docs
        .map((d) => ({
          id: d.id,
          name: d.data().name,
          email: String(d.data().email || "").toLowerCase(),
        }))
        .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      setBranches(list);
    } catch (e) {
      setError("Failed to load branches from Firestore.");
    }
    try {
      const res = await api.get("/api/branch/admin/list", { headers: authHeaders() });
      const byEmail = {};
      const byBranch = {};
      (res.data || []).forEach((c) => {
        if (c.email) byEmail[String(c.email).toLowerCase()] = c;
        if (c.branchId) byBranch[c.branchId] = c;
      });
      setCredByEmail(byEmail);
      setCredByBranchId(byBranch);
    } catch (e) {
      if (e.response?.status === 401) {
        setError("Your super-admin session expired. Please sign in again.");
      }
      // Otherwise the status column is just unavailable; setting still works.
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const flash = (m) => {
    setNotice(m);
    setTimeout(() => setNotice(""), 6000);
  };

  const credFor = (b) => credByBranchId[b.id] || credByEmail[b.email] || null;

  const genPassword = (b) => {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
    let out = "";
    const rand = new Uint32Array(14);
    (window.crypto || {}).getRandomValues?.(rand);
    for (let i = 0; i < 14; i++) out += chars[(rand[i] || Math.floor(Math.random() * 1e9)) % chars.length];
    setPw((p) => ({ ...p, [b.id]: out }));
    setShow((s) => ({ ...s, [b.id]: true }));
  };

  const handleSet = async (b) => {
    setError("");
    const password = String(pw[b.id] || "").trim();
    if (!b.email) {
      return setError(`${b.name}: this branch has no email. Add an email to the branch first.`);
    }
    if (password.length < 8) {
      return setError("Password must be at least 8 characters.");
    }
    setBusyId(b.id);
    try {
      await api.post(
        "/api/branch/admin/set-password",
        { branchId: b.id, email: b.email, password, mustChangePassword: true },
        { headers: authHeaders() }
      );
      flash(`Password set for ${b.name} (${b.email}). Share it securely — the branch will get a 6-digit OTP on each login.`);
      setPw((p) => ({ ...p, [b.id]: "" }));
      setShow((s) => ({ ...s, [b.id]: false }));
      await loadAll();
    } catch (e) {
      setError(e.response?.data?.error || "Could not set branch password.");
    } finally {
      setBusyId(null);
    }
  };

  const handleResetMfa = async (b) => {
    setError("");
    if (!b.email) {
      return setError(`${b.name}: this branch has no email. Add an email to the branch first.`);
    }
    const ok = window.confirm(
      `Reset MFA for ${b.name} (${b.email})?\n\nThis removes the branch's enrolled authenticator and signs out its active sessions. At the next login the branch will scan a new QR code to re-enroll.\n\nThis action is recorded in the audit log.`
    );
    if (!ok) return;
    setMfaBusyId(b.id);
    try {
      const res = await api.post(
        "/api/branch/admin/reset-mfa",
        { branchId: b.id, email: b.email },
        { headers: authHeaders() }
      );
      flash(res.data?.message || `MFA reset for ${b.name}.`);
    } catch (e) {
      setError(e.response?.data?.error || "Could not reset branch MFA.");
    } finally {
      setMfaBusyId(null);
    }
  };

  return (
    <div className="min-h-screen bg-gray-100 p-6">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Branch Login Passwords</h1>
            <p className="text-sm text-gray-500">
              Set or reset each branch's login password. The branch signs in with its email + this
              password, then a 6-digit code is emailed on every login.
            </p>
          </div>
          <button
            onClick={() => navigate("/admin/branches")}
            className="text-blue-600 hover:text-blue-800 text-sm font-medium"
          >
            &larr; Back to Branches
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-red-50 text-red-700 text-sm flex items-center justify-between gap-3">
            <span>{error}</span>
            <button
              type="button"
              onClick={loadAll}
              className="shrink-0 px-3 py-1 rounded-md bg-red-100 hover:bg-red-200 text-red-800 text-xs font-semibold"
            >
              Try again
            </button>
          </div>
        )}
        {notice && <div className="mb-4 p-3 rounded-lg bg-green-50 text-green-700 text-sm">{notice}</div>}

        <div className="bg-white rounded-xl shadow-sm overflow-hidden">
          {loading ? (
            <p className="p-6 text-gray-500">Loading...</p>
          ) : branches.length === 0 ? (
            <p className="p-6 text-gray-500">No branches found.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-gray-600 text-left">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Branch</th>
                    <th className="px-4 py-3 font-semibold">Login email</th>
                    <th className="px-4 py-3 font-semibold">Password</th>
                    <th className="px-4 py-3 font-semibold">Set / reset password</th>
                    <th className="px-4 py-3 font-semibold">MFA</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {branches.map((b) => {
                    const cred = credFor(b);
                    const hasPw = cred && cred.hasPassword;
                    return (
                      <tr key={b.id} className={busyId === b.id ? "opacity-50" : ""}>
                        <td className="px-4 py-3 font-medium text-gray-900">{b.name || "(unnamed)"}</td>
                        <td className="px-4 py-3 text-gray-700 break-all">{b.email || <span className="text-red-500">no email</span>}</td>
                        <td className="px-4 py-3">
                          <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${hasPw ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>
                            {hasPw ? "set" : "not set"}
                          </span>
                          {hasPw && cred.mustChangePassword && (
                            <span className="ml-2 text-xs text-amber-600">first-login</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <input
                              type={show[b.id] ? "text" : "password"}
                              value={pw[b.id] || ""}
                              onChange={(e) => setPw((p) => ({ ...p, [b.id]: e.target.value }))}
                              placeholder="New password (min 8)"
                              autoComplete="new-password"
                              className="px-3 py-1.5 border rounded-lg text-sm w-48"
                            />
                            <button
                              type="button"
                              onClick={() => setShow((s) => ({ ...s, [b.id]: !s[b.id] }))}
                              className="px-2 py-1.5 rounded-md bg-gray-100 text-gray-700 hover:bg-gray-200 text-xs font-medium"
                            >
                              {show[b.id] ? "Hide" : "Show"}
                            </button>
                            <button
                              type="button"
                              onClick={() => genPassword(b)}
                              className="px-2 py-1.5 rounded-md bg-indigo-100 text-indigo-700 hover:bg-indigo-200 text-xs font-medium"
                            >
                              Generate
                            </button>
                            <button
                              type="button"
                              onClick={() => handleSet(b)}
                              disabled={busyId === b.id || !b.email}
                              className={`px-3 py-1.5 rounded-md text-white text-xs font-semibold ${busyId === b.id || !b.email ? "bg-gray-400" : "bg-blue-600 hover:bg-blue-700"}`}
                            >
                              {busyId === b.id ? "Saving..." : hasPw ? "Reset" : "Set"}
                            </button>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <button
                            type="button"
                            onClick={() => handleResetMfa(b)}
                            disabled={mfaBusyId === b.id || !b.email}
                            title="Remove the branch's enrolled authenticator; they re-enroll via QR at next login"
                            className={`px-3 py-1.5 rounded-md text-xs font-semibold ${mfaBusyId === b.id || !b.email ? "bg-gray-200 text-gray-400" : "bg-amber-100 text-amber-700 hover:bg-amber-200"}`}
                          >
                            {mfaBusyId === b.id ? "Resetting..." : "Reset MFA"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <p className="text-xs text-gray-400 mt-4">
          Note: OTP delivery requires the backend email (SMTP) to be configured. If a branch has no
          email, set one on the branch first.
        </p>
      </div>
    </div>
  );
}

export default BranchPasswords;
