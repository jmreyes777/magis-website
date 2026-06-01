module.exports = {
    ensureGuestOwns: (req, res, next) => {
      const tokenGuestId = req.user?.guestId;           // set by your auth middleware
      const reqGuestId   = req.body.guestId  || req.params.guestId;
      if (!tokenGuestId || tokenGuestId !== reqGuestId) {
        return res.status(403).json({ error: "Forbidden – guestId mismatch" });
      }
      next();
    },
  
    ensureBranchOwns: (req, res, next) => {
      const tokenBranch = req.branchEmail?.toLowerCase();  // set by authenticateBranchAdmin
      const reqBranch   = (req.body.branchEmail || req.query.branchEmail || req.branchEmail)?.toLowerCase();
      if (!tokenBranch || tokenBranch !== reqBranch) {
        return res.status(403).json({ error: "Forbidden – branchEmail mismatch" });
      }
      next();
    },
  };