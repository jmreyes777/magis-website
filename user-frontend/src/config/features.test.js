// CHAT-PARK: unit tests for the parked-mode helpers in config/features.
import { telHref } from "./features";

describe("telHref — free-text branch phone → tel: link", () => {
  test("formats a plain PH mobile", () => {
    expect(telHref("0917-123-4567")).toBe("tel:09171234567");
  });

  test("takes the FIRST number from a multi-number field", () => {
    expect(telHref("(045) 888-1234 / 0917 123 4567")).toBe("tel:0458881234");
  });

  test("keeps a leading + country code", () => {
    expect(telHref("+63 917 123 4567")).toBe("tel:+639171234567");
  });

  test.each(["1234567890", "", undefined, "N/A"])(
    "returns null for unusable input %p",
    (input) => {
      expect(telHref(input)).toBeNull();
    }
  );
});
