// src/utils/layawayMath.js
// TST1 (testing megaplan): layaway/reservation math, extracted verbatim from
// the LayawayCalculator in Jewelry-Sales-User-Page.js for unit testing.
// Money math shown to customers — boundaries pinned by tests/layawayMath.test.js.

export const peso = (n) =>
  new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency: "PHP",
    maximumFractionDigits: 0,
  }).format(Math.round(n || 0));

export const roundUpTo = (n, step) => Math.ceil((n || 0) / step) * step;

// Round UP to the next ₱50/₱100 boundary (x00 or x50): 3101→3150, 3151→3200,
// exact x00/x50 stay put. Used for the +4% adjusted base in option 2.
export const roundBase = (n) => {
  const whole = Math.ceil(n || 0);
  const rem = whole % 100;
  if (rem === 0 || rem === 50) return whole;
  if (rem < 50) return whole + (50 - rem);
  return whole + (100 - rem);
};

// Option 1 — 2-week reservation: 10% down, 90% one-time balance, no fee.
export const opt1 = (p) => {
  const base = Math.round(p);
  const down = Math.round(base * 0.1);
  return {
    base,
    down,
    balance: base - down,
    months: "One-time payment within 2 weeks",
    label: "10% Down • 90% One-time",
  };
};

// Option 2 — extended layaway: +4% fee rounded to the next ₱50 boundary,
// 20% down (rounded up to ₱50), months tier keyed off the POST-FEE base.
export const opt2 = (p) => {
  const withFee = p * 1.04;
  const base = roundBase(withFee);
  const down = roundUpTo(base * 0.2, 50);
  const balance = base - down;
  let months = "Ask branch for terms";
  if (base >= 3000 && base <= 5000)
    months = "2 months to pay (80% Outstanding)";
  else if (base >= 5001) months = "3 months to pay (80% Outstanding)";
  return {
    base,
    withFee: Math.round(withFee),
    down,
    balance,
    months,
    label: "20% Down • +4% (rounded)",
  };
};
