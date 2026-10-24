import { generateKeyPair } from "node:crypto";
import { promisify } from "node:util";

/* The key pair a browser approval seals its answer to (RSA-OAEP, SHA-256):
   a login's credential, or a key asked for with `keys create`. Made fresh
   for each request, so only this process can open what the page sends. An
   object, so a test file can make one pair and reuse it: each takes 80 ms of
   CPU to make, most of the login and key tests' time (24 October 2026). */
export const sealing = {
  pair: (): Promise<{ publicKey: string; privateKey: string }> =>
    promisify(generateKeyPair)("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    }),
};
