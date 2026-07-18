// TST1 (testing megaplan): drives the pawn calculator through the real DOM —
// proves the page wires pawnMath correctly (dates → days → rate → interest)
// and that renew/redeem modes display the right totals.
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

import Pawning from "../Pawn-Service-User-Page";

const setup = () => {
  render(
    <MemoryRouter>
      <Pawning />
    </MemoryRouter>
  );
  const principal = screen.getByLabelText(/principal amount/i);
  const pawnDate = screen.getByLabelText(/^pawn date$/i);
  const paymentDate = screen.getByLabelText(/planned payment date/i);
  return { principal, pawnDate, paymentDate };
};

const fill = (el, value) => fireEvent.change(el, { target: { value } });

test("₱5,000 renewed after 10 days → 1.0% tier, ₱50.00 interest", () => {
  const { principal, pawnDate, paymentDate } = setup();
  fill(principal, "5000");
  fill(pawnDate, "2026-01-01");
  fill(paymentDate, "2026-01-11"); // exactly 10 days
  expect(screen.getByText("10 days")).toBeInTheDocument();
  expect(screen.getByText("1.0%")).toBeInTheDocument();
  expect(screen.getByText(/estimated to renew/i)).toBeInTheDocument();
  expect(screen.getByText("50.00")).toBeInTheDocument();
});

test("day 11 flips the tier: 1.5%, ₱75.00", () => {
  const { principal, pawnDate, paymentDate } = setup();
  fill(principal, "5000");
  fill(pawnDate, "2026-01-01");
  fill(paymentDate, "2026-01-12"); // 11 days
  expect(screen.getByText("1.5%")).toBeInTheDocument();
  expect(screen.getByText("75.00")).toBeInTheDocument();
});

test("redeem mode shows principal + interest", () => {
  const { principal, pawnDate, paymentDate } = setup();
  fill(principal, "5000");
  fill(pawnDate, "2026-01-01");
  fill(paymentDate, "2026-01-11");
  fireEvent.click(screen.getByRole("tab", { name: /redeem/i }));
  expect(screen.getByText(/total to redeem/i)).toBeInTheDocument();
  expect(screen.getByText("5,050.00")).toBeInTheDocument();
});

test("payment date before pawn date shows the error, no amounts", () => {
  const { principal, pawnDate, paymentDate } = setup();
  fill(principal, "5000");
  fill(pawnDate, "2026-01-10");
  fill(paymentDate, "2026-01-05");
  expect(
    screen.getByText(/cannot be earlier than the pawn date/i)
  ).toBeInTheDocument();
  expect(screen.queryByText(/estimated to renew/i)).not.toBeInTheDocument();
});
