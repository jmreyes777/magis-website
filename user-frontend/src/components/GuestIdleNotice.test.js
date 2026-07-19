// Idle auto-close notice — content guardrail. The walk-away protection erases
// the guest session after 5 idle minutes; this card is what explains it. The
// three claims are REQUIRED product copy (user spec, 2026-07-19):
//   1. the chat was closed due to inactivity
//   2. it happened for security reasons
//   3. the guest can chat again
import { render, screen, fireEvent } from "@testing-library/react";
import GuestIdleNotice, { IDLE_NOTICE_TITLE } from "./Guest-Idle-Notice-Component";

test("states inactivity, security purpose, and how to chat again", () => {
  render(<GuestIdleNotice minutes={5} onDismiss={() => {}} />);

  expect(screen.getByRole("alertdialog", { name: IDLE_NOTICE_TITLE })).toBeInTheDocument();
  expect(screen.getByText(/closed due to inactivity/i)).toBeInTheDocument();
  expect(screen.getByText(/for your security/i)).toBeInTheDocument();
  expect(screen.getByText(/5 minutes of\s+inactivity/i)).toBeInTheDocument();
  expect(screen.getByText(/chat with us again anytime/i)).toBeInTheDocument();
});

test("dismiss button hands control back (unmount → chat button available)", () => {
  const onDismiss = jest.fn();
  render(<GuestIdleNotice onDismiss={onDismiss} />);

  fireEvent.click(screen.getByRole("button", { name: /got it/i }));
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

test("timeout length is parameterized, defaulting to 5 minutes", () => {
  const { unmount } = render(<GuestIdleNotice onDismiss={() => {}} />);
  expect(screen.getByText(/5 minutes/i)).toBeInTheDocument();
  unmount();

  render(<GuestIdleNotice minutes={10} onDismiss={() => {}} />);
  expect(screen.getByText(/10 minutes/i)).toBeInTheDocument();
});
