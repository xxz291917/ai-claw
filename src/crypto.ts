/**
 * AES-256-GCM encrypt/decrypt utilities for user secrets.
 *
 * Storage format: base64( iv[16] + authTag[16] + ciphertext[…] )
 * Requires a 32-byte key derived from the SECRET_KEY env var.
 */

import { randomBytes, createCipheriv, createDecipheriv, createHash } from "node:crypto";

const ALG = "aes-256-gcm";
const IV_LEN = 16;
const TAG_LEN = 16;

/** Derive a deterministic 32-byte key from an arbitrary-length secret string. */
export function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");
}

export function decrypt(encoded: string, key: Buffer): string {
  const buf = Buffer.from(encoded, "base64");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(enc, undefined, "utf8") + decipher.final("utf8");
}
