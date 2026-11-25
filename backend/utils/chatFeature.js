// CHAT-PARK: single switch for the public (guest-facing) live chat. Off unless
// CHAT_ENABLED=true. Staff/admin routes are never gated here.
const isChatEnabled = () => String(process.env.CHAT_ENABLED || "").trim().toLowerCase() === "true";

const requireChatEnabled = (req, res, next) => {
  if (isChatEnabled()) return next();
  res.set("Cache-Control", "no-store");
  return res.status(503).json({ error: "Live chat is currently unavailable.", code: "CHAT_DISABLED" });
};

module.exports = { isChatEnabled, requireChatEnabled };
