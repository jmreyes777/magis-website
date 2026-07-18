// TST1 (testing megaplan): layaway money math. The subtle part (documented
// here because it is easy to get wrong): opt2's month tier keys off the
// POST-FEE ROUNDED base — roundBase(price * 1.04) — not the tag price.
import { peso, roundUpTo, roundBase, opt1, opt2 } from "./layawayMath";

describe("roundUpTo", () => {
  test.each([
    [0, 50, 0],
    [1, 50, 50],
    [50, 50, 50],
    [51, 50, 100],
    [1040, 50, 1050],
  ])("roundUpTo(%s, %s) = %s", (n, step, want) => {
    expect(roundUpTo(n, step)).toBe(want);
  });
});

describe("roundBase — next ₱50/₱100 boundary, exact boundaries stay", () => {
  test.each([
    [3100, 3100], // exact ₱100 boundary
    [3150, 3150], // exact ₱50 boundary
    [3101, 3150], // remainder < 50 → up to x50
    [3149, 3150],
    [3151, 3200], // remainder > 50 → up to next x00
    [3199, 3200],
    [3100.5, 3150], // fractional → ceil to whole first
    [0, 0],
  ])("roundBase(%s) = %s", (n, want) => {
    expect(roundBase(n)).toBe(want);
  });
});

describe("opt1 — 10% down, 90% one-time, no fee", () => {
  test("₱5,000 tag", () => {
    const r = opt1(5000);
    expect(r).toMatchObject({ base: 5000, down: 500, balance: 4500 });
    expect(r.months).toBe("One-time payment within 2 weeks");
  });
  test("down + balance always reassembles the base", () => {
    for (const p of [999, 3000, 4321, 5555.4, 12345]) {
      const r = opt1(p);
      expect(r.down + r.balance).toBe(r.base);
    }
  });
});

describe("opt2 — +4% fee, 20% down (₱50-rounded), tier off POST-FEE base", () => {
  test("₱5,000 tag → base 5200 → 3-month tier", () => {
    const r = opt2(5000);
    expect(r.withFee).toBe(5200);
    expect(r.base).toBe(5200);
    expect(r.down).toBe(1050); // 20% = 1040 → next ₱50 = 1050
    expect(r.balance).toBe(4150);
    expect(r.months).toBe("3 months to pay (80% Outstanding)");
  });
  test("₱4,000 tag → base 4200 → 2-month tier", () => {
    const r = opt2(4000);
    expect(r.base).toBe(4200); // 4160 → next boundary 4200
    expect(r.down).toBe(850); // 840 → 850
    expect(r.balance).toBe(3350);
    expect(r.months).toBe("2 months to pay (80% Outstanding)");
  });
  test("₱2,500 tag → base 2600 → below tiers → ask branch", () => {
    const r = opt2(2500);
    expect(r.base).toBe(2600);
    expect(r.months).toBe("Ask branch for terms");
  });
  test("tier boundary: post-fee base exactly 3000 (tag ₱2,880) → 2 months", () => {
    const r = opt2(2880); // 2880*1.04 = 2995.2 → roundBase → 3000
    expect(r.base).toBe(3000);
    expect(r.months).toBe("2 months to pay (80% Outstanding)");
  });
  test("tier boundary: post-fee base exactly 5000 (tag ₱4,805) → still 2 months", () => {
    const r = opt2(4805); // 4997.2 → roundBase → 5000 (inclusive upper bound)
    expect(r.base).toBe(5000);
    expect(r.months).toBe("2 months to pay (80% Outstanding)");
  });
  test("first base above 5000 is 5050 (tag ₱4,820) → 3 months", () => {
    const r = opt2(4820); // 5012.8 → roundBase → 5050
    expect(r.base).toBe(5050);
    expect(r.months).toBe("3 months to pay (80% Outstanding)");
  });
  test("properties across many prices: down is a ₱50 multiple, parts reassemble base, base is a 50-boundary ≥ withFee", () => {
    for (let p = 100; p <= 20000; p += 137) {
      const r = opt2(p);
      expect(r.down % 50).toBe(0);
      expect(r.down + r.balance).toBe(r.base);
      expect(r.base % 50).toBe(0);
      expect(r.base).toBeGreaterThanOrEqual(p * 1.04 - 1e-9);
    }
  });
});

describe("peso formatter", () => {
  test("whole pesos, PHP symbol, no centavos", () => {
    expect(peso(5000)).toBe("₱5,000");
    expect(peso(1049.5)).toBe("₱1,050"); // rounds
    expect(peso(0)).toBe("₱0");
  });
});
