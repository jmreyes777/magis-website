// Gold price watch — conversion + indicator guardrails.
// XAU comes in USD per troy ounce; branches quote PHP per GRAM, so the
// component must divide by 31.1034768 after the USD→PHP conversion.
import { act, render, screen } from "@testing-library/react";
import GoldPriceTicker, {
  GRAMS_PER_TROY_OUNCE,
  formatUpdatedAgo,
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
