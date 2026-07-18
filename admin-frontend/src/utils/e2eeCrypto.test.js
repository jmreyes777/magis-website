// ADM1 — end-to-end encryption for the branch<->guest chat.
//
// Real crypto, no mocks: setupTests wires Node's webcrypto into jsdom, so
// these tests perform actual ECDH P-256 handshakes and AES-256-GCM
// encryption exactly as two browsers would. If an algorithm name, curve,
// key length, or tag length drifts, these fail loudly.

import {
  generateKeyPair,
  exportPublicKey,
  importPublicKey,
  deriveSharedKey,
  encryptMessage,
  decryptMessage,
  encryptMedia,
  decryptMedia,
  initializeE2EE,
  completeKeyExchange,
  establishWithServerKey,
  isE2EEEstablished,
  e2eeEncrypt,
  e2eeDecrypt,
  clearE2EE,
  clearAllE2EE,
} from "./e2eeCrypto";

afterEach(() => clearAllE2EE());

describe("ECDH handshake + AES-GCM message roundtrip", () => {
  test("two independent parties derive the same channel and can talk both ways", async () => {
    // Alice = this module's keyStore; Bob = a hand-rolled peer.
    const alice = await initializeE2EE("guest-1");
    const bobPair = await generateKeyPair();
    const bobPublicB64 = await exportPublicKey(bobPair.publicKey);

    await completeKeyExchange("guest-1", bobPublicB64);
    const bobShared = await deriveSharedKey(
      bobPair.privateKey,
      await importPublicKey(alice.publicKey)
    );

    // Alice -> Bob
    const msg = "Magandang umaga! Item #A-1023 ready for release 💍";
    const { ciphertext, iv } = await e2eeEncrypt("guest-1", msg);
    expect(ciphertext).not.toContain("Magandang");
    await expect(decryptMessage(bobShared, ciphertext, iv)).resolves.toBe(msg);

    // Bob -> Alice
    const reply = await encryptMessage(bobShared, "Salamat po — 3pm pickup");
    await expect(
      e2eeDecrypt("guest-1", reply.ciphertext, reply.iv)
    ).resolves.toBe("Salamat po — 3pm pickup");
  });

  test("same plaintext encrypts to different ciphertext+iv every time", async () => {
    await establishWithServerKey(
      "guest-iv",
      Buffer.from(new Uint8Array(32).fill(7)).toString("base64")
    );
    const a = await e2eeEncrypt("guest-iv", "repeat");
    const b = await e2eeEncrypt("guest-iv", "repeat");
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  test("tampered ciphertext fails authentication with the friendly error", async () => {
    await establishWithServerKey(
      "guest-tamper",
      Buffer.from(new Uint8Array(32).fill(9)).toString("base64")
    );
    const { ciphertext, iv } = await e2eeEncrypt("guest-tamper", "sensitive");
    const bytes = Buffer.from(ciphertext, "base64");
    bytes[0] ^= 0xff; // flip one bit
    await expect(
      e2eeDecrypt("guest-tamper", bytes.toString("base64"), iv)
    ).rejects.toThrow(/tampering or wrong key/);
  });

  test("a third party's key cannot decrypt the channel", async () => {
    const alice = await initializeE2EE("guest-eve");
    const bobPair = await generateKeyPair();
    await completeKeyExchange("guest-eve", await exportPublicKey(bobPair.publicKey));
    const { ciphertext, iv } = await e2eeEncrypt("guest-eve", "for bob only");

    const evePair = await generateKeyPair();
    const eveShared = await deriveSharedKey(
      evePair.privateKey,
      await importPublicKey(alice.publicKey)
    );
    await expect(decryptMessage(eveShared, ciphertext, iv)).rejects.toThrow();
  });
});

describe("server-managed conversation key (offline-capable path)", () => {
  test("both sides importing the same raw key can talk immediately", async () => {
    const rawKey = Buffer.from(
      Uint8Array.from({ length: 32 }, (_, i) => i * 7)
    ).toString("base64");

    await establishWithServerKey("conv-1", rawKey);
    expect(isE2EEEstablished("conv-1")).toBe(true);

    // Peer session in the same test: separate guestId, same key.
    await establishWithServerKey("conv-1-peer", rawKey);
    const out = await e2eeEncrypt("conv-1", "server-keyed message");
    await expect(
      e2eeDecrypt("conv-1-peer", out.ciphertext, out.iv)
    ).resolves.toBe("server-keyed message");
  });
});

describe("session lifecycle", () => {
  test("established only after key exchange completes", async () => {
    expect(isE2EEEstablished("guest-lc")).toBe(false);
    await initializeE2EE("guest-lc");
    expect(isE2EEEstablished("guest-lc")).toBe(false); // handshake incomplete
    const peer = await generateKeyPair();
    await completeKeyExchange("guest-lc", await exportPublicKey(peer.publicKey));
    expect(isE2EEEstablished("guest-lc")).toBe(true);
  });

  test("encrypt/decrypt before establishment throws", async () => {
    await expect(e2eeEncrypt("nobody", "x")).rejects.toThrow(/not established/);
    await expect(e2eeDecrypt("nobody", "x", "y")).rejects.toThrow(/not established/);
  });

  test("completeKeyExchange without init throws", async () => {
    const peer = await generateKeyPair();
    await expect(
      completeKeyExchange("uninit", await exportPublicKey(peer.publicKey))
    ).rejects.toThrow(/not initialized/);
  });

  test("clearE2EE forgets the session (logout hygiene)", async () => {
    await establishWithServerKey(
      "guest-clear",
      Buffer.from(new Uint8Array(32)).toString("base64")
    );
    expect(isE2EEEstablished("guest-clear")).toBe(true);
    clearE2EE("guest-clear");
    expect(isE2EEEstablished("guest-clear")).toBe(false);
    await expect(e2eeEncrypt("guest-clear", "x")).rejects.toThrow(/not established/);
  });
});

describe("media encryption", () => {
  test("binary roundtrip preserves every byte (pawn ticket photo scenario)", async () => {
    await establishWithServerKey(
      "guest-media",
      Buffer.from(new Uint8Array(32).fill(3)).toString("base64")
    );
    // Simulated small binary: every byte value 0-255 repeated.
    const original = Uint8Array.from({ length: 1024 }, (_, i) => i % 256);
    const store = { buffer: original.buffer };

    const { ciphertext, iv } = await encryptMedia(
      // reach the shared key through the public API: encrypt with session,
      // decrypt with the same session's raw functions
      await importServerKey(),
      store.buffer
    );
    const roundtripped = await decryptMedia(await importServerKey(), ciphertext, iv);
    expect(new Uint8Array(roundtripped)).toEqual(original);

    async function importServerKey() {
      const raw = Uint8Array.from(new Uint8Array(32).fill(3)).buffer;
      return window.crypto.subtle.importKey(
        "raw",
        raw,
        { name: "AES-GCM" },
        false,
        ["encrypt", "decrypt"]
      );
    }
  });
});
