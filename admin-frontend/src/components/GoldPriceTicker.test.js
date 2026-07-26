// Gold price watch — conversion + indicator guardrails.
// XAU comes in USD per troy ounce; branches quote PHP per GRAM, so the
// component must divide by 31.1034768 after the USD→PHP conversion.
import { act, fireEvent, render, screen } from "@testing-library/react";
import GoldPriceTicker, {
  GRAMS_PER_TROY_OUNCE,
  formatUpdatedAgo,
  isGoldMarketClosed,
  fmtSignedPct,
  sparklinePoints,
  isStaffSession,
} from "./GoldPriceTicker-Component";

const goldResponse = { name: "Gold", price: 3000, symbol: "XAU" };
const fxResponse = { result: "success", rates: { PHP: 58 } };

const NOW = Date.now();
const summaryResponse = {
  current: { t: NOW, phpPerGram: 5594.23 },
  deltas: {
    d1: { pct: 1.25, from: 5525, fromT: NOW - 86400000 },
    d7: { pct: 3.4, from: 5410, fromT: NOW - 7 * 86400000 },
    d30: { pct: -0.8, from: 5639, fromT: NOW - 30 * 86400000 },
  },
  week: { high: 5620, low: 5400 },
  sparkline: [
    { t: NOW - 3 * 86400000, g: 5410 },
    { t: NOW - 86400000, g: 5525 },
    { t: NOW, g: 5594.23 },
  ],
  baseline: null,
  drift: null,
};

// header.payload.sig with a base64url JSON payload — enough for jwt-decode.
const fakeJwt = (payload) =>
  `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify(payload))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")}.sig`;

function mockFetchOk(summary = summaryResponse) {
  global.fetch = jest.fn((url) => {
    const u = String(url);
    const body = u.includes("gold-api")
      ? goldResponse
      : u.includes("/api/gold/summary")
        ? summary
        : fxResponse;
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  });
}

afterEach(() => {
  jest.restoreAllMocks();
  sessionStorage.clear();
  localStorage.clear();
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

// ── Trend intel (backend /api/gold/summary) ─────────────────────────────

test("fmtSignedPct: explicit sign, em-minus, dash for missing", () => {
  expect(fmtSignedPct(1.25)).toBe("+1.25%");
  expect(fmtSignedPct(-0.8)).toBe("−0.80%");
  expect(fmtSignedPct(0)).toBe("0.00%");
  expect(fmtSignedPct(null)).toBe("—");
});

test("sparklinePoints maps min→bottom, max→top, spans the width", () => {
  const pts = sparklinePoints(
    [
      { t: 0, g: 100 },
      { t: 50, g: 150 },
      { t: 100, g: 200 },
    ],
    132,
    36,
    3
  );
  const coords = pts.split(" ").map((p) => p.split(",").map(Number));
  expect(coords).toHaveLength(3);
  expect(coords[0][0]).toBeCloseTo(3);      // first x = pad
  expect(coords[2][0]).toBeCloseTo(129);    // last x = w - pad
  expect(coords[0][1]).toBeCloseTo(33);     // min value → bottom
  expect(coords[2][1]).toBeCloseTo(3);      // max value → top
  expect(sparklinePoints([{ t: 0, g: 1 }])).toBe(""); // too short → empty
});

test("isStaffSession reads the staff claim, defaults false on garbage", () => {
  expect(isStaffSession(fakeJwt({ role: "branchadmin", staff: true }))).toBe(true);
  expect(isStaffSession(fakeJwt({ role: "branchadmin" }))).toBe(false);
  expect(isStaffSession("not-a-jwt")).toBe(false);
  expect(isStaffSession(null)).toBe(false);
});

test("renders the Δ1d chip and opens the trend panel with deltas + baseline CTA", async () => {
  sessionStorage.setItem("branchAdminToken", fakeJwt({ role: "branchadmin" }));
  mockFetchOk();
  await act(async () => {
    render(<GoldPriceTicker />);
  });

  // Δtoday chip inline in the ticker.
  expect(await screen.findByText("+1.25%")).toBeInTheDocument();
  expect(screen.queryByText("REPRICE")).not.toBeInTheDocument();

  // Click → panel with 1/7/30d deltas, week range, and (management) the CTA.
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { expanded: false }));
  });
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(screen.getByText("7D")).toBeInTheDocument();
  expect(screen.getByText("+3.40%")).toBeInTheDocument();
  expect(screen.getByText("−0.80%")).toBeInTheDocument();
  expect(screen.getByText(/no pricing baseline yet/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /mark repriced/i })).toBeInTheDocument();
});

test("staff sessions see the panel but not the baseline controls", async () => {
  sessionStorage.setItem(
    "branchAdminToken",
    fakeJwt({ role: "branchadmin", staff: true })
  );
  mockFetchOk();
  await act(async () => {
    render(<GoldPriceTicker />);
  });
  await screen.findByText("+1.25%");

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { expanded: false }));
  });
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /mark repriced/i })).not.toBeInTheDocument();
});

test("drift beyond threshold raises the REPRICE alert with direction guidance", async () => {
  sessionStorage.setItem("branchAdminToken", fakeJwt({ role: "branchadmin" }));
  mockFetchOk({
    ...summaryResponse,
    baseline: { phpPerGram: 5400, thresholdPct: 2, setAt: NOW - 5 * 86400000 },
    drift: { pct: 3.6, thresholdPct: 2, reprice: true },
  });
  await act(async () => {
    render(<GoldPriceTicker />);
  });

  // Inline alert tag on the chip…
  expect(await screen.findByText("REPRICE")).toBeInTheDocument();

  // …and the panel explains the drift + suggested direction.
  await act(async () => {
    fireEvent.click(screen.getByText("GOLD"));
  });
  expect(screen.getByText(/reprice suggested/i)).toBeInTheDocument();
  expect(screen.getByText(/raising loan values/i)).toBeInTheDocument();
});

test("no summary → ticker still works, no trend chip, panel explains", async () => {
  sessionStorage.setItem("branchAdminToken", fakeJwt({ role: "branchadmin" }));
  global.fetch = jest.fn((url) => {
    const u = String(url);
    if (u.includes("/api/gold/summary")) {
      return Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) });
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(u.includes("gold-api") ? goldResponse : fxResponse),
    });
  });
  await act(async () => {
    render(<GoldPriceTicker />);
  });

  expect(await screen.findByText(/5,594\.23/)).toBeInTheDocument();
  expect(screen.queryByText("+1.25%")).not.toBeInTheDocument();

  await act(async () => {
    fireEvent.click(screen.getByText("GOLD"));
  });
  expect(screen.getByText(/trend data unavailable/i)).toBeInTheDocument();
});
