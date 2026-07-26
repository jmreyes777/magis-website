// Gold price watch — conversion + indicator guardrails.
// XAU comes in USD per troy ounce; branches quote PHP per GRAM, so the
// component must divide by 31.1034768 after the USD→PHP conversion.
import { act, render, screen } from "@testing-library/react";
import GoldPriceTicker, {
  GRAMS_PER_TROY_OUNCE,
  formatUpdatedAgo,
  isGoldMarketClosed,
} from "./GoldPriceTicker-Component";

const goldResponse = { name: "Gold", price: 3000, symbol: "XAU" };
const fxResponse = { result: "success", rates: { PHP: 58 } };

function mockFetchOk() {
  global.fetch = jest.fn((url) =>
    Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve(
          String(url).includes("gold-api") ? goldResponse : fxResponse
        ),
    })
  );
}

afterEach(() => {
  jest.restoreAllMocks();
});

test("shows the PHP-per-gram conversion with a Last updated indicator", async () => {
  mockFetchOk();
  await act(async () => {
    render(<GoldPriceTicker />);
  });

  // 3000 USD/ozt * 58 PHP/USD / 31.1034768 g/ozt = 5,594.23 PHP/g
  const expected = (3000 * 58) / GRAMS_PER_TROY_OUNCE;
  expect(expected).toBeCloseTo(5594.23, 2);

  expect(await screen.findByText(/5,594\.23/)).toBeInTheDocument();
  expect(screen.getByText(/\/g/)).toBeInTheDocument();
  expect(screen.getByText(/Updated just now/i)).toBeInTheDocument();
  expect(screen.getByText("GOLD")).toBeInTheDocument();
});

test("keeps a graceful state when the APIs are unreachable", async () => {
  global.fetch = jest.fn(() => Promise.reject(new Error("network down")));
  await act(async () => {
    render(<GoldPriceTicker />);
  });

  // No price ever received → unavailable, never a crash or NaN.
  expect(await screen.findByText(/unavailable/i)).toBeInTheDocument();
  expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
});

test("formatUpdatedAgo buckets: just now → seconds → minutes → hours", () => {
  const now = Date.now();
  expect(formatUpdatedAgo(now, now)).toBe("just now");
  expect(formatUpdatedAgo(now - 30 * 1000, now)).toBe("30s ago");
  expect(formatUpdatedAgo(now - 5 * 60 * 1000, now)).toBe("5m ago");
  expect(formatUpdatedAgo(now - 3 * 60 * 60 * 1000, now)).toBe("3h ago");
  expect(formatUpdatedAgo(null, now)).toBe("");
});

test("isGoldMarketClosed: weekend window Fri 5pm → Sun 6pm ET, DST-aware", () => {
  // Summer (EDT = UTC-4). Jul 2026: Wed 22, Fri 24, Sat 25, Sun 26.
  expect(isGoldMarketClosed(new Date("2026-07-22T16:00:00Z"))).toBe(false); // Wed 12:00 ET
  expect(isGoldMarketClosed(new Date("2026-07-24T20:59:00Z"))).toBe(false); // Fri 16:59 ET
  expect(isGoldMarketClosed(new Date("2026-07-24T21:00:00Z"))).toBe(true);  // Fri 17:00 ET
  expect(isGoldMarketClosed(new Date("2026-07-25T12:00:00Z"))).toBe(true);  // Saturday
  expect(isGoldMarketClosed(new Date("2026-07-26T21:59:00Z"))).toBe(true);  // Sun 17:59 ET
  expect(isGoldMarketClosed(new Date("2026-07-26T22:00:00Z"))).toBe(false); // Sun 18:00 ET

  // Winter (EST = UTC-5). Fri Jan 16, 2026.
  expect(isGoldMarketClosed(new Date("2026-01-16T21:59:00Z"))).toBe(false); // Fri 16:59 ET
  expect(isGoldMarketClosed(new Date("2026-01-16T22:00:00Z"))).toBe(true);  // Fri 17:00 ET
});

test("shows the market-closed hint while the weekend freeze is active", async () => {
  jest.useFakeTimers().setSystemTime(new Date("2026-07-25T12:00:00Z")); // Saturday
  mockFetchOk();
  await act(async () => {
    render(<GoldPriceTicker />);
  });

  expect(screen.getByText(/market closed/i)).toBeInTheDocument();
  jest.useRealTimers();
});
