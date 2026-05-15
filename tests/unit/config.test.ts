/**
 * Unit tests for configuration loading and validation.
 * 
 * Tests the loadConfig() function with various environment variable scenarios
 * to ensure proper validation and error handling.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { ConfigurationError } from '../../src/utils/errors.js';

describe('loadConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset environment variables before each test
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    // Restore original environment variables after each test
    process.env = originalEnv;
  });

  it('should load valid configuration with all required variables', () => {
    process.env.SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com';
    process.env.WALLET_KEYPAIR_PATH = '/path/to/wallet.json';

    const config = loadConfig();

    expect(config).toEqual({
      solanaRpcUrl: 'https://api.mainnet-beta.solana.com',
      walletKeypairPath: '/path/to/wallet.json',
      aceDataCloudBaseUrl: 'https://api.acedata.cloud',
      facilitatorUrl: 'https://facilitator.acedata.cloud',
      sentinelWallet: 'Ccr2yK3hLALU4p8oNRqrh4dGuvPJTth5KCLMio8cE1ph',
      usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      network: 'solana',
    });
  });

  it('should use custom values for optional variables when provided', () => {
    process.env.SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com';
    process.env.WALLET_KEYPAIR_PATH = '/path/to/wallet.json';
    process.env.ACEDATA_BASE_URL = 'https://custom.acedata.cloud';
    process.env.FACILITATOR_URL = 'https://custom.facilitator.acedata.cloud';
    process.env.USDC_MINT = 'CustomUSDCMint123';
    process.env.NETWORK = 'base';

    const config = loadConfig();

    expect(config.aceDataCloudBaseUrl).toBe('https://custom.acedata.cloud');
    expect(config.facilitatorUrl).toBe('https://custom.facilitator.acedata.cloud');
    expect(config.usdcMint).toBe('CustomUSDCMint123');
    expect(config.network).toBe('base');
  });

  it('should throw ConfigurationError when SOLANA_RPC_URL is missing', () => {
    process.env.WALLET_KEYPAIR_PATH = '/path/to/wallet.json';
    delete process.env.SOLANA_RPC_URL;

    expect(() => loadConfig()).toThrow(ConfigurationError);
    expect(() => loadConfig()).toThrow('missing required environment variable(s): SOLANA_RPC_URL');
  });

  it('should throw ConfigurationError when WALLET_KEYPAIR_PATH is missing', () => {
    process.env.SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com';
    delete process.env.WALLET_KEYPAIR_PATH;

    expect(() => loadConfig()).toThrow(ConfigurationError);
    expect(() => loadConfig()).toThrow('missing required environment variable(s): WALLET_KEYPAIR_PATH');
  });

  it('should throw ConfigurationError listing ALL missing variables when multiple are absent', () => {
    delete process.env.SOLANA_RPC_URL;
    delete process.env.WALLET_KEYPAIR_PATH;

    expect(() => loadConfig()).toThrow(ConfigurationError);
    
    const error = (() => {
      try {
        loadConfig();
        return null;
      } catch (e) {
        return e as ConfigurationError;
      }
    })();

    expect(error).not.toBeNull();
    expect(error!.message).toContain('SOLANA_RPC_URL');
    expect(error!.message).toContain('WALLET_KEYPAIR_PATH');
  });

  it('should throw ConfigurationError when required variables are empty strings', () => {
    process.env.SOLANA_RPC_URL = '';
    process.env.WALLET_KEYPAIR_PATH = '   '; // whitespace only

    expect(() => loadConfig()).toThrow(ConfigurationError);
  });

  it('should have correct error code for ConfigurationError', () => {
    delete process.env.SOLANA_RPC_URL;

    try {
      loadConfig();
      expect.fail('Should have thrown ConfigurationError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as ConfigurationError).code).toBe('CONFIGURATION_ERROR');
    }
  });
});