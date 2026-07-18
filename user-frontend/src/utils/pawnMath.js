// src/utils/pawnMath.js
// TST1 (testing megaplan): the pawn interest math, extracted verbatim from
// Pawn-Service-User-Page.js so it can be unit-tested. This is money math shown
// to customers — every tier boundary is pinned by tests/pawnMath.test.js.
// Rates mirror the in-branch matrix (sample rates; final computation is
// always the printed pawn ticket).

// Tiered interest rate (%) by whole days elapsed since the pawn date.
export const getRateFromDays = (d) => {
  if (d <= 10) return 1.0;
  if (d <= 20) return 1.5;
  if (d <= 30) return 3.0;
  if (d <= 60) return 8.5;
  if (d <= 90) return 14.5;
  if (d <= 120) return 21.5;
  if (d <= 150) return 28.5;
  return 35.5; // 6th month and beyond
};

// Whole days between two dates, rounding any partial day UP (a pawn renewed
// one hour into day 11 pays day-11 rates — matches branch practice).
export const daysBetween = (start, end) =>
  Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));

export const computeInterest = (principal, rate) => (principal * rate) / 100;
