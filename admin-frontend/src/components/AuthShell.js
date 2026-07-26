// admin-frontend/src/components/AuthShell.js
//
// Shared branded chrome for every auth-adjacent surface (unified branch login,
// super-admin login, passkey settings, portal landing) — everything EXCEPT the
// chat dashboard. One place defines the look: minimalist, white-dominant,
// modern/high-tech, with the Magi's logo colors used sparingly as accents:
//
//   navy  #232268 / #1b1a52  (the "MAGI'S" wordmark ink)  → primary actions
//   gold  #c9a227 (+ #e5dcc8 hairlines, #faf7ef washes)   → focus/accents
//
// Deliberately presentation-only: no routing, no fetching, no state. Pages
// keep their exact copy, placeholders, and control texts (e2e contracts).

import React from "react";

// ── Brand tokens ──────────────────────────────────────────────────────────────
export const BRAND = {
  navy: "#232268",
  navyDeep: "#1b1a52",
  gold: "#c9a227",
  goldSoft: "#e5dcc8",
  cream: "#faf7ef",
};

// ── Reusable control styles (Tailwind class strings) ─────────────────────────
export const INPUT =
  "w-full rounded-xl border border-[#e4e3ef] bg-white px-4 py-2.5 text-[15px] text-slate-800 " +
  "placeholder-slate-400 outline-none transition-all duration-150 " +
  "focus:border-[#232268] focus:ring-4 focus:ring-[#c9a227]/20";

// Centered variant for one-time codes (OTP / TOTP / reset codes).
export const INPUT_CODE =
  "w-full rounded-xl border border-[#e4e3ef] bg-white px-4 py-3 text-center font-mono " +
  "text-slate-800 placeholder-slate-300 outline-none transition-all duration-150 " +
  "focus:border-[#232268] focus:ring-4 focus:ring-[#c9a227]/20";

export const BTN_PRIMARY =
  "w-full rounded-xl py-2.5 font-semibold tracking-wide text-white transition-all duration-150 " +
  "bg-gradient-to-b from-[#2c2b7c] to-[#1b1a52] shadow-[0_2px_10px_-2px_rgba(27,26,82,0.45)] " +
  "hover:from-[#232268] hover:to-[#141340] hover:shadow-[0_4px_16px_-2px_rgba(27,26,82,0.5)] " +
  "active:scale-[0.99]";

export const BTN_BUSY =
  "w-full rounded-xl py-2.5 font-semibold tracking-wide text-white bg-slate-300 cursor-wait";

export const BTN_OUTLINE =
  "w-full rounded-xl py-2.5 font-semibold tracking-wide transition-all duration-150 " +
  "border border-[#232268]/25 text-[#232268] bg-white " +
  "hover:border-[#c9a227]/60 hover:bg-[#faf7ef] active:scale-[0.99]";

export const LINK_BTN =
  "w-full text-sm font-medium text-[#232268]/80 transition-colors " +
  "hover:text-[#c9a227] disabled:text-slate-400";

export const MSG_ERROR =
  "mb-4 rounded-xl border border-red-100 bg-red-50 px-3 py-2 text-center text-sm text-red-600";

export const MSG_INFO =
  "mb-4 rounded-xl border border-[#e5dcc8] bg-[#faf7ef] px-3 py-2 text-center text-sm text-[#232268]";

export const MSG_SUCCESS =
  "mb-4 rounded-xl border border-emerald-100 bg-emerald-50 px-3 py-2 text-center text-sm text-emerald-700";

// ── Brand mark: the actual Magi's logo, framed as a compact plaque ───────────
// The artwork lives on its own gold field (public/images/magis cover photo.png),
// so it is shown as a small rounded tile — the brand stays vivid while the card
// around it stays white-dominant.
export function BrandMark() {
  return (
    <div className="mb-6 flex flex-col items-center select-none">
      <img
        src="/images/magis cover photo.png"
        alt="Magi's Gold & Gems Pawnshop & Jewellery"
        draggable="false"
        className="h-[72px] w-auto rounded-xl border border-[#e5dcc8] shadow-[0_6px_18px_-8px_rgba(201,162,39,0.55)]"
      />
      <span className="mt-4 h-px w-16 bg-gradient-to-r from-transparent via-[#e5dcc8] to-transparent" />
    </div>
  );
}

// ── Page shell: warm-white field, faint grid + brand glows, floating card ───
export default function AuthShell({ title, subtitle, width = "w-96", children }) {
  return (
    <div
      className="min-h-screen flex items-center justify-center px-4 py-10 bg-[#faf9f6]"
      style={{
        backgroundImage: [
          // whisper-quiet brand glows (gold top-left, navy bottom-right)
          "radial-gradient(60rem 34rem at 12% -6%, rgba(201,162,39,0.07), transparent 60%)",
          "radial-gradient(52rem 30rem at 96% 108%, rgba(35,34,104,0.06), transparent 60%)",
          // fine engineering grid — the "high-tech" undertone
          "linear-gradient(rgba(35,34,104,0.028) 1px, transparent 1px)",
          "linear-gradient(90deg, rgba(35,34,104,0.028) 1px, transparent 1px)",
        ].join(", "),
        backgroundSize: "auto, auto, 28px 28px, 28px 28px",
      }}
    >
      <div className={`relative ${width} max-w-full`}>
        {/* gold→navy accent hairline, floating just above the card */}
        <div
          className="absolute -top-px left-8 right-8 h-[3px] rounded-full opacity-90"
          style={{ background: "linear-gradient(90deg, #c9a227, #232268)" }}
          aria-hidden="true"
        />
        <div className="rounded-2xl border border-[#ececf3] bg-white px-8 py-9 shadow-[0_18px_50px_-18px_rgba(27,26,82,0.25)]">
          <BrandMark />
          {title && (
            <h1 className="mb-1 text-center text-2xl font-bold text-slate-900">{title}</h1>
          )}
          {subtitle && (
            <p className="mb-6 text-center text-xs text-slate-500">{subtitle}</p>
          )}
          {children}
        </div>
        <p className="mt-4 text-center text-[11px] tracking-wide text-slate-400">
          Secured area &middot; Magis Gold &amp; Gems
        </p>
      </div>
    </div>
  );
}
