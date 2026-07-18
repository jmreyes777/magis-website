// jest-dom adds custom jest matchers for asserting on DOM nodes.
// allows you to do things like:
// expect(element).toHaveTextContent(/react/i)
// learn more: https://github.com/testing-library/jest-dom
import '@testing-library/jest-dom';

// CRA's jest 27 jsdom predates crypto.randomUUID and exposes no SubtleCrypto.
// Wire Node's own webcrypto in so initSession (randomUUID) and e2eeCrypto
// (subtle AES-GCM/ECDH) exercise real crypto instead of mocks.
const nodeCrypto = require("crypto");
const { TextEncoder, TextDecoder } = require("util");
if (typeof globalThis.TextEncoder === "undefined") {
  globalThis.TextEncoder = TextEncoder;
  globalThis.TextDecoder = TextDecoder;
}
// jsdom (jest 27) has no BroadcastChannel; Admin-Utils-socket creates one at
// import time for multi-tab coordination. A stub (not Node's real one) keeps
// the event loop clean — real channels hold the process open.
if (typeof globalThis.BroadcastChannel === "undefined") {
  globalThis.BroadcastChannel = class BroadcastChannel {
    constructor(name) {
      this.name = name;
      this.onmessage = null;
    }
    postMessage() {}
    addEventListener() {}
    removeEventListener() {}
    close() {}
  };
}

if (typeof globalThis.crypto === "undefined") {
  globalThis.crypto = nodeCrypto.webcrypto;
} else {
  if (!globalThis.crypto.randomUUID) {
    globalThis.crypto.randomUUID = nodeCrypto.randomUUID.bind(nodeCrypto);
  }
  if (!globalThis.crypto.subtle && nodeCrypto.webcrypto) {
    Object.defineProperty(globalThis.crypto, "subtle", {
      value: nodeCrypto.webcrypto.subtle,
    });
  }
}
