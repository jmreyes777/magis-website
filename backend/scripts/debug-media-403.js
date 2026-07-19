// One-off diagnostic for the guest media 403 (2026-07-19). Read-only.
// Prints the guestId stored on the failing branch reply vs the guestId on the
// guest's own message in the same thread — the ownership compare uses these.
const { initFirebase } = require("../utils/firebase");

(async () => {
  const { db } = initFirebase();
  const failingId = process.argv[2] || "mTg7CG5ybaW71B2quTnZ";

  const snap = await db.collection("messages").doc(failingId).get();
  if (!snap.exists) {
    console.log(`doc ${failingId}: NOT FOUND`);
    process.exit(0);
  }
  const m = snap.data();
  console.log("FAILING REPLY DOC:");
  console.log(JSON.stringify({
    id: failingId,
    guestId: m.guestId,
    branchId: m.branchId,
    branchEmail: m.branchEmail,
    sender: m.sender,
    media: m.media ? { type: m.media.type, path: m.media.path } : null,
    timestamp: m.timestamp,
  }, null, 2));

  // The guest's own docs in the same conversation (these resolve fine).
  // Exact-match query first; if empty, the guest's docs carry a DIFFERENT
  // guestId string than the reply — which is precisely the 403.
  const exact = await db.collection("messages")
    .where("guestId", "==", m.guestId)
    .limit(10)
    .get();
  console.log(`\nDOCS WITH IDENTICAL guestId string: ${exact.size}`);
  exact.forEach((d) => {
    const g = d.data();
    console.log(` id=${d.id} sender=${g.sender} media=${!!g.media} ts=${g.timestamp}`);
  });

  // Wider sweep: same UUID CORE, any prefix/case form.
  const core = String(m.guestId).toLowerCase().replace(/^guest-/, "");
  const sweep = await db.collection("messages")
    .where("branchEmail", "==", m.branchEmail)
    .limit(60)
    .get();
  const forms = new Map();
  sweep.forEach((d) => {
    const g = d.data();
    const gid = String(g.guestId || "");
    if (gid.toLowerCase().replace(/^guest-/, "") === core) {
      forms.set(gid, (forms.get(gid) || 0) + 1);
    }
  });
  console.log("\nguestId STRING FORMS in this thread (normalized-equal):");
  forms.forEach((n, form) => console.log(` ${JSON.stringify(form)} x${n}`));
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
