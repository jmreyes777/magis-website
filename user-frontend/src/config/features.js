// CHAT-PARK: build-time switch for the guest live chat. Off unless the build
// sets REACT_APP_CHAT_ENABLED=true (pair it with CHAT_ENABLED=true on the
// backend). Build-time on purpose: prerendered HTML and the hydrated app must
// agree, so the value can never differ between snapshot and client.
export const CHAT_ENABLED = process.env.REACT_APP_CHAT_ENABLED === "true";

export const MESSENGER_URL = "https://m.me/magispawnshop";
export const SUPPORT_PHONE = { label: "Globe", number: "0962-061-8672" };

// tel: href for a free-text branch phone field. First number only; seed
// placeholders and unusable values return null (render no call link).
export const telHref = (phone) => {
  const first = String(phone || "").split(/[\/,;|]|\bor\b/i)[0];
  const digits = first.replace(/[^\d+]/g, "");
  if (digits.replace(/\D/g, "").length < 7) return null;
  if (/^1234567890?$/.test(digits.replace(/\D/g, ""))) return null;
  return `tel:${digits}`;
};
