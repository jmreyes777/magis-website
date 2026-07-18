// TST1 (testing megaplan): pins every interest-rate tier boundary. These
// numbers are shown to customers as money — a one-digit regression here is a
// real-world financial error, which is why each boundary has BOTH sides tested.
import { getRateFromDays, daysBetween, computeInterest } from "./pawnMath";

describe("getRateFromDays — tier table (both sides of every boundary)", () => {
  const table = [
    [0, 1.0],
    [1, 1.0],
    [10, 1.0],
    [11, 1.5],
    [20, 1.5],
    [21, 3.0],
    [30, 3.0],
    [31, 8.5],
    [60, 8.5],
    [61, 14.5],
    [90, 14.5],
    [91, 21.5],
    [120, 21.5],
    [121, 28.5],
    [150, 28.5],
    [151, 35.5],
    [999, 35.5],
  ];
  test.each(table)("%i day(s) → %s%%", (days, rate) => {
    expect(getRateFromDays(days)).toBe(rate);
  });
});

describe("daysBetween — partial days round UP", () => {
  const d = (s) => new Date(s);
  test("same instant → 0 days", () => {
    expect(daysBetween(d("2026-01-01T00:00:00"), d("2026-01-01T00:00:00"))).toBe(0);
  });
  test("one hour later → 1 day", () => {
    expect(daysBetween(d("2026-01-01T00:00:00"), d("2026-01-01T01:00:00"))).toBe(1);
  });
  test("exactly 10 days → 10 (stays in 1% tier)", () => {
    expect(daysBetween(d("2026-01-01"), d("2026-01-11"))).toBe(10);
  });
  test("10 days + 1 minute → 11 (tier flips to 1.5%)", () => {
    expect(daysBetween(d("2026-01-01T00:00:00"), d("2026-01-11T00:01:00"))).toBe(11);
  });
  test("date-only inputs: Jan 1 → Feb 1 = 31", () => {
    expect(daysBetween(d("2026-01-01"), d("2026-02-01"))).toBe(31);
  });
});

describe("computeInterest", () => {
  test("₱5,000 at 1% → ₱50", () => {
    expect(computeInterest(5000, 1.0)).toBe(50);
  });
  test("₱5,000 at 3% → ₱150", () => {
    expect(computeInterest(5000, 3.0)).toBe(150);
  });
  test("₱10,000 at 35.5% → ₱3,550 (worst tier)", () => {
    expect(computeInterest(10000, 35.5)).toBe(3550);
  });
  test("fractional principal computes exactly", () => {
    expect(computeInterest(1234.56, 8.5)).toBeCloseTo(104.9376, 10);
  });
});

describe("integration of the three (what the page renders)", () => {
  test("₱5,000 renewed on day 10 costs ₱50; on day 11 costs ₱75", () => {
    const day10 = computeInterest(5000, getRateFromDays(10));
    const day11 = computeInterest(5000, getRateFromDays(11));
    expect(day10).toBe(50);
    expect(day11).toBe(75);
  });
});
