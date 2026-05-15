/**
 * walletService.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wallet creation, import, and encryption management.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { privateKeyToAccount, mnemonicToAccount } from 'viem/accounts';
import { encrypt, decrypt } from '../storage/crypto.js';
import type { Wallet } from '../types/index.js';
import { randomBytes } from 'node:crypto';

function generateId(): string {
  return randomBytes(8).toString('hex');
}

function normalizePrivateKey(pk: string): `0x${string}` {
  return (pk.startsWith('0x') ? pk : `0x${pk}`) as `0x${string}`;
}

/**
 * Create a wallet from a private key string.
 * Validates the key is a valid EVM private key.
 */
export function createWalletFromPrivateKey(privateKey: string, label?: string): Wallet {
  const normalized = normalizePrivateKey(privateKey.trim());
  const account = privateKeyToAccount(normalized);

  return {
    id: generateId(),
    address: account.address,
    privateKey: normalized,    // will be encrypted before storage
    phrase: undefined,
    label: label || `Wallet ${account.address.slice(0, 6)}...${account.address.slice(-4)}`,
    addedAt: Date.now(),
  };
}

/**
 * Create a wallet from a BIP39 mnemonic phrase.
 */
export function createWalletFromMnemonic(phrase: string, label?: string): Wallet {
  const trimmed = phrase.trim();
  const account = mnemonicToAccount(trimmed);
  const hdKey   = account.getHdKey();
  const pk      = hdKey.privateKey;
  if (!pk) throw new Error('Failed to derive private key from mnemonic');

  const privateKey = `0x${Buffer.from(pk).toString('hex')}` as `0x${string}`;

  return {
    id: generateId(),
    address: account.address,
    privateKey,
    phrase: trimmed,
    label: label || `Wallet ${account.address.slice(0, 6)}...${account.address.slice(-4)}`,
    addedAt: Date.now(),
  };
}

/**
 * Encrypt sensitive fields on a wallet before storing in MongoDB.
 */
export function encryptWallet(wallet: Wallet): Wallet {
  return {
    ...wallet,
    privateKey: encrypt(wallet.privateKey),
    phrase: wallet.phrase ? encrypt(wallet.phrase) : undefined,
  };
}

/**
 * Decrypt sensitive fields on a wallet after reading from MongoDB.
 */
export function decryptWallet(wallet: Wallet): Wallet {
  return {
    ...wallet,
    privateKey: decrypt(wallet.privateKey),
    phrase: wallet.phrase ? decrypt(wallet.phrase) : undefined,
  };
}

/**
 * Get a viem account object from a (decrypted) wallet.
 */
export function getAccountFromWallet(wallet: Wallet) {
  const pk = normalizePrivateKey(wallet.privateKey);
  return privateKeyToAccount(pk);
}

/**
 * Mask a wallet address for display: 0x1234...abcd
 */
export function maskAddress(address: string): string {
  if (address.length < 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/**
 * Validate a private key string — returns true if it looks valid.
 */
export function isValidPrivateKey(value: string): boolean {
  try {
    const normalized = normalizePrivateKey(value.trim());
    privateKeyToAccount(normalized);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a mnemonic phrase — returns true if it looks valid.
 */
export function isValidMnemonic(phrase: string): boolean {
  try {
    mnemonicToAccount(phrase.trim());
    return true;
  } catch {
    return false;
  }
}
