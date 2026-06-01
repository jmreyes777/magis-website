const fs = require('fs');

// Read the socket.js file
let content = fs.readFileSync('utils/socket.js', 'utf8');

// Find the debugLog line and add E2EE handlers after it
const debugLogLine = '    socket.on("debugLog", (log) => console.log(`[DEBUG]`, log));';
const e2eeHandlers = `
    // E2EE Key Exchange handlers
    socket.on("e2ee:guest_key", async (data) => {
      console.log("[E2EE] 🔑 Guest key received:", data);
      try {
        const { guestId, branchEmail, publicKey, role } = data;
        if (!guestId || !branchEmail || !publicKey) return;
        io.to(getRoomName("admin", branchEmail)).emit("e2ee:guest_key", data);
        console.log("[E2EE] 📡 Routed guest key to admins");
      } catch (err) { console.error("[E2EE] Error:", err); }
    });

    socket.on("e2ee:branch_key", async (data) => {
      console.log("[E2EE] 🔑 Branch key received:", data);
      try {
        const { guestId, branchEmail, publicKey, role } = data;
        if (!guestId || !branchEmail || !publicKey) return;
        io.to(getRoomName("guest", guestId)).emit("e2ee:branch_key", data);
        console.log("[E2EE] 📡 Routed branch key to guest");
      } catch (err) { console.error("[E2EE] Error:", err); }
    });`;

// Replace the debugLog line with debugLog + E2EE handlers
const newContent = content.replace(debugLogLine, debugLogLine + e2eeHandlers);

// Write back to file
fs.writeFileSync('utils/socket.js', newContent, 'utf8');

console.log('E2EE handlers added to socket.js');
