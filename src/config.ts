/**
 * Configuration loading and validation for the Autonomous Bounty Agent.
 * 
 * Loads all required environment variables using Zod for validation and
 * throws ConfigurationError listing ALL missing variables when any required
 * variable is absent.
 * 
 * Requirements: 14.1, 14.2, 14.3, 14.4, 14.5
 */

import { z } from 'zod';
import { config } from 'dotenv';
import { BountyAgentConfig } from './types/index.js';
import { ConfigurationError } from './utils/errors.js';

// Load environment variables from .env file
config();

/**
 * Zod schema for validating environment variables.
 * Required variables: SOLANA_RPC_URL, WALLET_KEYPAIR_PATH
 * Optional variables with defaults: ACEDATA_BASE_URL, FACILITATOR_URL, USDC_MINT, NETWORK
 */
const envSchema = z.object({
  SOLANA_RPC_URL: z.string().min(1, 'SOLANA_RPC_URL cannot be empty'),
  WALLET_KEYPAIR_PATH: z.string().min(1, 'WALLET_KEYPAIR_PATH cannot be empty'),
  ACEDATA_BASE_URL: z.string().default('https://api.acedata.cloud'),
  FACILITATOR_URL: z.string().default('https://facilitator.acedata.cloud'),
  USDC_MINT: z.string().default('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  NETWORK: z.enum(['solana', 'base']).default('solana'),
});

/**
 * Loads and validates configuration from environment variables.
 * 
 * @returns BountyAgentConfig with all required settings
 * @throws ConfigurationError listing ALL missing variable names when any required var is absent
 */
export function loadConfig(): BountyAgentConfig {
  // Collect all missing required variables
  const missingVars: string[] = [];
  
  // Check each required environment variable
  if (!process.env.SOLANA_RPC_URL || process.env.SOLANA_RPC_URL.trim() === '') {
    missingVars.push('SOLANA_RPC_URL');
  }
  
  if (!process.env.WALLET_KEYPAIR_PATH || process.env.WALLET_KEYPAIR_PATH.trim() === '') {
    missingVars.push('WALLET_KEYPAIR_PATH');
  }
  
  // If any required variables are missing, throw ConfigurationError with ALL missing names
  if (missingVars.length > 0) {
    throw new ConfigurationError(missingVars);
  }
  
  // Parse and validate all environment variables
  const result = envSchema.safeParse(process.env);
  
  if (!result.success) {
    // Extract field names from Zod validation errors
    const zodMissingVars = result.error.issues
      .filter(issue => issue.code === 'invalid_type' && issue.received === 'undefined')
      .map(issue => issue.path[0] as string);
    
    if (zodMissingVars.length > 0) {
      throw new ConfigurationError(zodMissingVars);
    }
    
    // For other validation errors, throw with the first error message
    throw new ConfigurationError([result.error.issues[0].message]);
  }
  
  const env = result.data;
  
  return {
    solanaRpcUrl: env.SOLANA_RPC_URL,
    walletKeypairPath: env.WALLET_KEYPAIR_PATH,
    aceDataCloudBaseUrl: env.ACEDATA_BASE_URL,
    facilitatorUrl: env.FACILITATOR_URL,
    sentinelWallet: 'Ccr2yK3hLALU4p8oNRqrh4dGuvPJTth5KCLMio8cE1ph', // Fixed Synapse Sentinel wallet
    usdcMint: env.USDC_MINT,
    network: env.NETWORK,
  };
}