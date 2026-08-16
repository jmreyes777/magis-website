/**
 * Firestore security-rules tests for the A01-4 hardening.
 *
 * Validates that the rules in ./firestore.rules:
 *   - DENY all unauthenticated access to `messages` (read / list / create / update)
 *   - keep branch-admin reads scoped to their own branch
 *   - DENY anonymous `guests` creation
 *   - DENY the formerly-public reads (`siteConfig`, `branches`, `branchStatus`)
 *     — closed once the public site moved to the backend API endpoints
 *     (/api/site-config/*, /api/branch-status) and dropped the client SDK
 *   - keep the superadmin/branchadmin dashboard access paths working
 *
 * Run against the Firestore emulator (no production project touched):
 *
 *   npm i -D @firebase/rules-unit-testing firebase firebase-tools
 *   npx firebase emulators:exec --only firestore "node --test firestore.rules.test.mjs"
 */
import { readFileSync } from "node:fs";
import { test, before, after, beforeEach } from "node:test";
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from "@firebase/rules-unit-testing";
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  collection,
  getDocs,
} from "firebase/firestore";

const PROJECT_ID = "magis-rules-test";

const VALID_MESSAGE = {
  guestId: "guest-abcdefghij",
  branchId: "branch-1",
  branchEmail: "branch@example.com",
  sender: "guest",
  timestamp: "2026-01-01T00:00:00.000Z",
  archived: false,
  content: "hello",
};

let testEnv;

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync("firestore.rules", "utf8") },
  });
});

after(async () => {
  if (testEnv) await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
});

const anon = () => testEnv.unauthenticatedContext().firestore();
const branchAdmin = (email, branchId) =>
  testEnv
    .authenticatedContext("admin-uid", { role: "branchadmin", email, branchId })
    .firestore();
const superAdmin = () =>
  testEnv
    .authenticatedContext("super-uid", { role: "superadmin" })
    .firestore();

// Seed docs through the privileged path (bypasses rules), mirroring the
// backend Admin SDK which is what writes messages/guests in production.
async function seed(path, id, data) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), path, id), data);
  });
}

test("messages: anonymous client CANNOT read a single message", async () => {
  await seed("messages", "m1", VALID_MESSAGE);
  await assertFails(getDoc(doc(anon(), "messages", "m1")));
});

test("messages: anonymous client CANNOT list the collection", async () => {
  await seed("messages", "m1", VALID_MESSAGE);
  await assertFails(getDocs(collection(anon(), "messages")));
});

test("messages: anonymous client CANNOT create a message", async () => {
  await assertFails(setDoc(doc(anon(), "messages", "m2"), VALID_MESSAGE));
});

test("messages: anonymous client CANNOT toggle archived", async () => {
  await seed("messages", "m1", VALID_MESSAGE);
  await assertFails(updateDoc(doc(anon(), "messages", "m1"), { archived: true }));
});

test("messages: branch admin CAN read a message for their own branch", async () => {
  await seed("messages", "m1", { ...VALID_MESSAGE, branchEmail: "branch@example.com" });
  const db = branchAdmin("branch@example.com", "branch-1");
  await assertSucceeds(getDoc(doc(db, "messages", "m1")));
});

test("messages: branch admin CANNOT read another branch's message", async () => {
  await seed("messages", "m1", { ...VALID_MESSAGE, branchEmail: "other@example.com" });
  const db = branchAdmin("branch@example.com", "branch-1");
  await assertFails(getDoc(doc(db, "messages", "m1")));
});

test("guests: anonymous client CANNOT create a guest doc", async () => {
  await assertFails(
    setDoc(doc(anon(), "guests", "guest-abcdefghij"), {
      guestName: "Test",
      guestPhone: "0900",
      guestEmail: "t@example.com",
      branchId: "branch-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    })
  );
});

test("guests: branch admin CAN read a guest in their own branch", async () => {
  await seed("guests", "guest-abcdefghij", { guestName: "Test", branchId: "branch-1" });
  const db = branchAdmin("branch@example.com", "branch-1");
  await assertSucceeds(getDoc(doc(db, "guests", "guest-abcdefghij")));
});

test("siteConfig: anonymous client CANNOT read (served via /api/site-config/*)", async () => {
  await seed("siteConfig", "auction", { date: "2026-12-01" });
  await assertFails(getDoc(doc(anon(), "siteConfig", "auction")));
});

test("branches: anonymous client CANNOT read (served via /api/site-config/branches)", async () => {
  await seed("branches", "branch-1", { name: "Main" });
  await assertFails(getDoc(doc(anon(), "branches", "branch-1")));
});

test("branches: anonymous client CANNOT list the collection", async () => {
  await seed("branches", "branch-1", { name: "Main" });
  await assertFails(getDocs(collection(anon(), "branches")));
});

test("branches: superadmin CAN list (dashboard branch/staff/password pages)", async () => {
  await seed("branches", "branch-1", { name: "Main" });
  await assertSucceeds(getDocs(collection(superAdmin(), "branches")));
});

test("branches: branchadmin CANNOT read (no branchadmin page reads branches)", async () => {
  await seed("branches", "branch-1", { name: "Main" });
  const db = branchAdmin("branch@example.com", "branch-1");
  await assertFails(getDoc(doc(db, "branches", "branch-1")));
});

test("branchStatus: anonymous client CANNOT read (served via /api/branch-status)", async () => {
  await seed("branchStatus", "branch@example.com", { online: true });
  await assertFails(getDoc(doc(anon(), "branchStatus", "branch@example.com")));
});

test("branchStatus: branch admin CAN read presence", async () => {
  await seed("branchStatus", "branch@example.com", { online: true });
  const db = branchAdmin("branch@example.com", "branch-1");
  await assertSucceeds(getDoc(doc(db, "branchStatus", "branch@example.com")));
});

test("branchStatus: owning branch admin CAN update their own presence doc", async () => {
  await seed("branchStatus", "branch@example.com", { online: false });
  const db = branchAdmin("branch@example.com", "branch-1");
  await assertSucceeds(
    updateDoc(doc(db, "branchStatus", "branch@example.com"), { online: true })
  );
});

test("branchStatus: branch admin CANNOT update another branch's presence doc", async () => {
  await seed("branchStatus", "other@example.com", { online: false });
  const db = branchAdmin("branch@example.com", "branch-1");
  await assertFails(
    updateDoc(doc(db, "branchStatus", "other@example.com"), { online: true })
  );
});
