router.post("/api/ping-broadcast", express.json(), async (req, res) => {
    const { branchEmail, sessionTabId, timestamp } = req.body || {};
    if (!branchEmail || !sessionTabId) return res.sendStatus(400);
  
    const key = `${branchEmail}::${sessionTabId}`;
    broadcastMap.set(key, timestamp || Date.now());
    console.log(`[BROADCAST] 🕊️ Received passive broadcast from ${key}`);
    res.sendStatus(200);
  });