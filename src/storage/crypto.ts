/**
 * crypto.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AES-256-GCM encryption for wallet sensitive fields (privateKey, phrase).
 *
 * Format: enc:v1:<iv_hex>:<authTag_hex>:<ciphertext_hex>
 * The prefix makes encrypt/decrypt idempotent (already-encrypted = skipped).
 *
 * Env: WALLET_ENCRYPTION_KEY — 64 hex chars (32 bytes)
 * Generate: openssl rand -hex 32
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm' as const;
const IV_BYTES   = 12;  // 96-bit IV — recommended for GCM
const KEY_BYTES  = 32;  // 256-bit key
const PREFIX     = 'enc:v1:';

function loadKey(): Buffer {
  const hex = process.env.WALLET_ENCRYPTION_KEY;
  if (!hex) throw new Error('❌ WALLET_ENCRYPTION_KEY is not set in environment');
  const key = Buffer.from(hex, 'hex');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `❌ WALLET_ENCRYPTION_KEY must be ${KEY_BYTES * 2} hex chars. Got ${key.length * 2}.`,
    );
  }
  return key;
}

/** Encrypt a plaintext string. Returns enc:v1:... string. Idempotent. */
export function encrypt(plaintext: string): string {
  if (isEncrypted(plaintext)) return plaintext;
  const key    = loadKey();
  const iv     = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag    = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

/** Decrypt a string produced by encrypt(). Returns plaintext. Idempotent. */
export function decrypt(ciphertext: string): string {
  if (!isEncrypted(ciphertext)) return ciphertext;
  const key   = loadKey();
  const parts = ciphertext.slice(PREFIX.length).split(':');
  if (parts.length !== 3) throw new Error('❌ Malformed encrypted wallet field');
  const [ivHex, authTagHex, dataHex] = parts as [string, string, string];
  const iv      = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const data    = Buffer.from(dataHex, 'hex');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(data).toString('utf8') + decipher.final('utf8');
}

/** Returns true when the value was produced by encrypt(). */
export function isEncrypted(value: string): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}
