/**
 * Keypair loading utility for Hello-pay.
 * 
 * Safely loads and validates Solana keypairs from JSON files without
 * exposing raw key material in error messages or logs.
 * 
 * Requirements: 1.4, 1.5, 14.6
 */

import { readFileSync } from 'fs';
import { Keypair } from '@solana/web3.js';
import { InvalidKeypairError } from './errors.js';

/**
 * Loads a Solana keypair from a JSON file containing a 64-element number array.
 * 
 * @param walletKeypairPath - Filesystem path to the keypair JSON file
 * @returns A valid Solana Keypair instance
 * @throws InvalidKeypairError if the file is missing or contains invalid data
 * 
 * Security: Never logs or exposes raw key bytes in error messages.
 * 
 * Requirements: 1.4, 1.5, 14.6
 */
export function loadKeypair(walletKeypairPath: string): Keypair {
  let fileContent: string;
  
  // Attempt to read the file
  try {
    fileContent = readFileSync(walletKeypairPath, 'utf-8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new InvalidKeypairError(
        `Keypair file not found at path: ${walletKeypairPath}`
      );
    }
    throw new InvalidKeypairError(
      `Failed to read keypair file at ${walletKeypairPath}: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }

  // Parse JSON content
  let parsedData: unknown;
  try {
    parsedData = JSON.parse(fileContent);
  } catch (error) {
    throw new InvalidKeypairError(
      `Keypair file contains invalid JSON at ${walletKeypairPath}`
    );
  }

  // Validate that it's an array
  if (!Array.isArray(parsedData)) {
    throw new InvalidKeypairError(
      `Keypair file must contain an array, got ${typeof parsedData} at ${walletKeypairPath}`
    );
  }

  // Validate array length
  if (parsedData.length !== 64) {
    throw new InvalidKeypairError(
      `Keypair file must contain exactly 64 elements, got ${parsedData.length} at ${walletKeypairPath}`
    );
  }

  // Validate all elements are numbers in valid byte range (0-255)
  for (let i = 0; i < parsedData.length; i++) {
    const element = parsedData[i];
    if (typeof element !== 'number' || !Number.isInteger(element) || element < 0 || element > 255) {
      throw new InvalidKeypairError(
        `Keypair file contains invalid byte at index ${i}: expected integer 0-255, got ${typeof element} at ${walletKeypairPath}`
      );
    }
  }

  // Convert to Uint8Array and create Keypair
  try {
    const secretKey = new Uint8Array(parsedData as number[]);
    return Keypair.fromSecretKey(secretKey);
  } catch (error) {
    throw new InvalidKeypairError(
      `Failed to create Keypair from secret key data at ${walletKeypairPath}: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}