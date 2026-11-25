// CHAT-PARK: build-time switch for the branch live-chat UI. Off unless the
// build sets REACT_APP_CHAT_ENABLED=true (same value as the guest site build;
// the backend's switch is CHAT_ENABLED). The admin socket still connects when
// this is off — it carries session plumbing (token rotation, tab ownership),
// and the backend only refuses GUEST sockets.
export const CHAT_ENABLED = process.env.REACT_APP_CHAT_ENABLED === "true";
// Where branch/staff sessions land after login.
export const BRANCH_HOME = CHAT_ENABLED ? "/admin/chats" : "/admin/audit";
