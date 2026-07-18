// TST1 (testing megaplan): drives the layaway calculator through the real DOM
// on the Jewelry Sales page — proves the page wires layawayMath correctly for
// both plans, including the ₱50-rounded down payment and post-fee month tiers.
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Presentation-only collaborators are not under test.
jest.mock("../../components/Seo", () => ({
  __esModule: true,
  default: () => null,
  SITE_ORIGIN: "https://www.magispawnshop.com",
}));
jest.mock("../../components/Footer-User-Component", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("../../components/FacebookLatestVideo", () => ({
  __esModule: true,
  default: () => null,
}));

import JewelrySales from "../Jewelry-Sales-User-Page";

const setup = () => {
  render(
    <MemoryRouter>
      <JewelrySales />
    </MemoryRouter>
  );
  return { price: screen.getByRole("spinbutton") };
};

test("default: ₱5,000 on Option 2 → ₱1,050 down, ₱4,150 balance, 3-month tier", () => {
  setup();
  expect(screen.getByText("₱1,050")).toBeInTheDocument(); // down (hero)
  // ₱5,000 * 1.04 = ₱5,200 lands exactly on a boundary, so BOTH the
  // "Principal + 4%" chip and the "Rounded base" chip show ₱5,200.
  expect(screen.getAllByText("₱5,200")).toHaveLength(2);
  expect(screen.getByText("₱4,150")).toBeInTheDocument(); // balance
  expect(screen.getByText("3 months to pay (80% Outstanding)")).toBeInTheDocument();
});

test("Option 1: ₱5,000 → ₱500 down, ₱4,500 one-time balance", () => {
  setup();
  fireEvent.click(screen.getByRole("button", { name: "Option 1" }));
  expect(screen.getByText("₱500")).toBeInTheDocument();
  expect(screen.getByText("₱4,500")).toBeInTheDocument();
  expect(screen.getByText("One-time payment within 2 weeks")).toBeInTheDocument();
});

test("₱4,000 on Option 2 lands in the 2-month tier (post-fee base ₱4,200)", () => {
  const { price } = setup();
  fireEvent.change(price, { target: { value: "4000" } });
  expect(screen.getByText("₱4,200")).toBeInTheDocument();
  expect(screen.getByText("₱850")).toBeInTheDocument();
  expect(screen.getByText("2 months to pay (80% Outstanding)")).toBeInTheDocument();
});

test("cheap item (₱2,500) → below tiers → ask branch for terms", () => {
  const { price } = setup();
  fireEvent.change(price, { target: { value: "2500" } });
  expect(screen.getByText("Ask branch for terms")).toBeInTheDocument();
});
