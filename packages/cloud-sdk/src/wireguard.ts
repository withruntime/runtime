import { generateKeyPairSync } from "node:crypto";

/** A WireGuard key pair, as `wg genkey | wg pubkey` makes: X25519, each half
 * 32 bytes of base64. Made on the machine that will use it, so the private
 * key is never sent anywhere. */
export function generateWireGuardKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const d = (privateKey.export({ format: "jwk" }) as { d: string }).d;
  const x = (publicKey.export({ format: "jwk" }) as { x: string }).x;
  return {
    privateKey: Buffer.from(d, "base64url").toString("base64"),
    publicKey: Buffer.from(x, "base64url").toString("base64"),
  };
}
