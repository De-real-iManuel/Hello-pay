/**
 * Unit tests for custom error classes in src/utils/errors.ts
 * Validates that each error class extends Error with a typed code property
 * and produces appropriate error messages.
 */

import { describe, it, expect } from 'vitest';
import {
  ConfigurationError,
  InvalidKeypairError,
  InsufficientSolError,
  InsufficientUsdcError,
  InsufficientFundsError,
  PaymentError,
  ContentValidationError,
  RegistrationError,
  DuplicateRunError,
  ImageGenerationTimeoutError,
} from '../../src/utils/errors.js';

describe('Custom Error Classes', () => {
  describe('ConfigurationError', () => {
    it('should create error with missing variables list', () => {
      const missingVars = ['SOLANA_RPC_URL', 'WALLET_KEYPAIR_PATH'];
      const error = new ConfigurationError(missingVars);

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(ConfigurationError);
      expect(error.name).toBe('ConfigurationError');
      expect(error.code).toBe('CONFIGURATION_ERROR');
      expect(error.message).toBe(
        'Configuration error: missing required environment variable(s): SOLANA_RPC_URL, WALLET_KEYPAIR_PATH'
      );
    });

    it('should handle single missing variable', () => {
      const error = new ConfigurationError(['SOLANA_RPC_URL']);
      expect(error.message).toContain('SOLANA_RPC_URL');
    });
  });

  describe('InvalidKeypairError', () => {
    it('should create error with custom message', () => {
      const message = 'Keypair file not found at specified path';
      const error = new InvalidKeypairError(message);

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(InvalidKeypairError);
      expect(error.name).toBe('InvalidKeypairError');
      expect(error.code).toBe('INVALID_KEYPAIR');
      expect(error.message).toBe(message);
    });

    it('should not expose raw key bytes in message', () => {
      const message = 'Invalid keypair format: expected 64-byte array';
      const error = new InvalidKeypairError(message);
      
      // Ensure message doesn't contain any potential key-like data
      expect(error.message).not.toMatch(/\[[\d,\s]+\]/);
      expect(error.message).not.toMatch(/[0-9a-fA-F]{64,}/);
    });
  });

  describe('InsufficientSolError', () => {
    it('should create error with balance details', () => {
      const currentBalance = 0.005;
      const requiredBalance = 0.015;
      const error = new InsufficientSolError(currentBalance, requiredBalance);

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(InsufficientSolError);
      expect(error.name).toBe('InsufficientSolError');
      expect(error.code).toBe('INSUFFICIENT_SOL');
      expect(error.message).toBe(
        'Insufficient SOL balance: wallet has 0.005000 SOL but requires at least 0.015000 SOL to cover SAP registration rent and transaction fees'
      );
    });

    it('should format balance numbers correctly', () => {
      const error = new InsufficientSolError(0.1234567, 0.015);
      expect(error.message).toContain('0.123457'); // 6 decimal places
      expect(error.message).toContain('0.015000');
    });
  });

  describe('InsufficientUsdcError', () => {
    it('should create error with USDC balance details', () => {
      const currentBalance = 0.25;
      const requiredBalance = 0.50;
      const error = new InsufficientUsdcError(currentBalance, requiredBalance);

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(InsufficientUsdcError);
      expect(error.name).toBe('InsufficientUsdcError');
      expect(error.code).toBe('INSUFFICIENT_USDC');
      expect(error.message).toBe(
        'Insufficient USDC balance: wallet has 0.250000 USDC but requires at least 0.500000 USDC to cover estimated API costs'
      );
    });
  });

  describe('InsufficientFundsError', () => {
    it('should create error with payment amount details', () => {
      const requiredAmount = 0.095215;
      const availableAmount = 0.05;
      const error = new InsufficientFundsError(requiredAmount, availableAmount);

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(InsufficientFundsError);
      expect(error.name).toBe('InsufficientFundsError');
      expect(error.code).toBe('INSUFFICIENT_FUNDS');
      expect(error.message).toBe(
        'Insufficient funds: x402 payment requires 0.095215 USDC but wallet only has 0.05 USDC available'
      );
    });
  });

  describe('PaymentError', () => {
    it('should create error with message only', () => {
      const message = 'x402 payment failed after max attempts';
      const error = new PaymentError(message);

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(PaymentError);
      expect(error.name).toBe('PaymentError');
      expect(error.code).toBe('PAYMENT_ERROR');
      expect(error.message).toBe(message);
      expect(error.httpStatus).toBeUndefined();
    });

    it('should create error with HTTP status', () => {
      const message = 'Payment verification failed';
      const httpStatus = 402;
      const error = new PaymentError(message, httpStatus);

      expect(error.message).toBe(message);
      expect(error.httpStatus).toBe(402);
    });
  });

  describe('ContentValidationError', () => {
    it('should create error with message only', () => {
      const message = 'LLM response content is empty';
      const error = new ContentValidationError(message);

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(ContentValidationError);
      expect(error.name).toBe('ContentValidationError');
      expect(error.code).toBe('CONTENT_VALIDATION_ERROR');
      expect(error.message).toBe(message);
      expect(error.contentLength).toBeUndefined();
    });

    it('should create error with content length', () => {
      const message = 'LLM response too short';
      const contentLength = 25;
      const error = new ContentValidationError(message, contentLength);

      expect(error.message).toBe(message);
      expect(error.contentLength).toBe(25);
    });
  });

  describe('RegistrationError', () => {
    it('should create error with custom message', () => {
      const message = 'SAP agent registration transaction failed';
      const error = new RegistrationError(message);

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(RegistrationError);
      expect(error.name).toBe('RegistrationError');
      expect(error.code).toBe('REGISTRATION_ERROR');
      expect(error.message).toBe(message);
    });
  });

  describe('DuplicateRunError', () => {
    it('should create error with topic information', () => {
      const topic = 'DeFi yield strategies Q3 2026';
      const error = new DuplicateRunError(topic);

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(DuplicateRunError);
      expect(error.name).toBe('DuplicateRunError');
      expect(error.code).toBe('DUPLICATE_RUN');
      expect(error.message).toBe(
        'A pipeline run for topic "DeFi yield strategies Q3 2026" is already in progress. Wait for the current run to complete before starting a new one.'
      );
    });
  });

  describe('ImageGenerationTimeoutError', () => {
    it('should create error with timeout duration', () => {
      const timeoutMs = 30000;
      const error = new ImageGenerationTimeoutError(timeoutMs);

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(ImageGenerationTimeoutError);
      expect(error.name).toBe('ImageGenerationTimeoutError');
      expect(error.code).toBe('IMAGE_GENERATION_TIMEOUT');
      expect(error.message).toBe(
        'Image generation timed out after 30000ms. The Midjourney task did not complete within the allowed time window.'
      );
      expect(error.timeoutMs).toBe(30000);
    });
  });

  describe('Error inheritance and prototype chain', () => {
    it('should maintain proper prototype chain for all error classes', () => {
      const errors = [
        new ConfigurationError(['TEST']),
        new InvalidKeypairError('test'),
        new InsufficientSolError(0.01, 0.015),
        new InsufficientUsdcError(0.25, 0.50),
        new InsufficientFundsError(0.1, 0.05),
        new PaymentError('test'),
        new ContentValidationError('test'),
        new RegistrationError('test'),
        new DuplicateRunError('test'),
        new ImageGenerationTimeoutError(5000),
      ];

      errors.forEach((error) => {
        expect(error).toBeInstanceOf(Error);
        expect(error.name).toBeTruthy();
        expect(error.code).toBeTruthy();
        expect(error.message).toBeTruthy();
        expect(error.stack).toBeTruthy();
      });
    });

    it('should have unique error codes', () => {
      const codes = [
        new ConfigurationError(['TEST']).code,
        new InvalidKeypairError('test').code,
        new InsufficientSolError(0.01, 0.015).code,
        new InsufficientUsdcError(0.25, 0.50).code,
        new InsufficientFundsError(0.1, 0.05).code,
        new PaymentError('test').code,
        new ContentValidationError('test').code,
        new RegistrationError('test').code,
        new DuplicateRunError('test').code,
        new ImageGenerationTimeoutError(5000).code,
      ];

      const uniqueCodes = new Set(codes);
      expect(uniqueCodes.size).toBe(codes.length);
    });
  });
});