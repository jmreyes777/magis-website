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
    });
