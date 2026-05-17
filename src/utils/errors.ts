/**
 * Custom error classes for Hello-pay.
 * Each error extends Error with a typed `code` property for programmatic handling.
 */

/**
 * Thrown when one or more required environment variables are missing or empty.
 * Requirements: 14.2
 */
export class ConfigurationError extends Error {
  readonly code: "CONFIGURATION_ERROR" = "CONFIGURATION_ERROR";

  constructor(missingVars: string[]) {
    super(
      `Configuration error: missing required environment variable(s): ${missingVars.join(", ")}`
    );
    this.name = "ConfigurationError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when the keypair file is missing or does not contain a valid 64-byte Solana keypair.
 * NEVER includes raw key bytes in the message.
 * Requirements: 1.4, 1.5
 */
export class InvalidKeypairError extends Error {
  readonly code: "INVALID_KEYPAIR" = "INVALID_KEYPAIR";

  constructor(message: string) {
    super(message);
    this.name = "InvalidKeypairError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when the wallet's SOL balance is below the minimum required threshold (0.015 SOL).
 * Requirements: 13.1
 */
export class InsufficientSolError extends Error {
  readonly code: "INSUFFICIENT_SOL" = "INSUFFICIENT_SOL";

  constructor(currentBalance: number, requiredBalance: number) {
    super(
      `Insufficient SOL balance: wallet has ${currentBalance.toFixed(6)} SOL but requires at least ${requiredBalance.toFixed(6)} SOL to cover SAP registration rent and transaction fees`
    );
    this.name = "InsufficientSolError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when the wallet's USDC SPL token balance is below the minimum required threshold (0.50 USDC).
 * Requirements: 13.2
 */
export class InsufficientUsdcError extends Error {
  readonly code: "INSUFFICIENT_USDC" = "INSUFFICIENT_USDC";

  constructor(currentBalance: number, requiredBalance: number) {
    super(
      `Insufficient USDC balance: wallet has ${currentBalance.toFixed(6)} USDC but requires at least ${requiredBalance.toFixed(6)} USDC to cover estimated API costs`
    );
    this.name = "InsufficientUsdcError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when the wallet's USDC balance is insufficient to cover a specific x402 payment.
 * Must NOT be retried — thrown immediately before signing the payment envelope.
 * Requirements: 8.5, 12.3
 */
export class InsufficientFundsError extends Error {
  readonly code: "INSUFFICIENT_FUNDS" = "INSUFFICIENT_FUNDS";

  constructor(requiredAmount: number, availableAmount: number) {
    super(
      `Insufficient funds: x402 payment requires ${requiredAmount} USDC but wallet only has ${availableAmount} USDC available`
    );
    this.name = "InsufficientFundsError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when an x402 payment handshake fails (e.g., max retries exceeded, missing x402_tx header,
 * or no Solana-compatible payment option in the 402 accepts array).
 * Must NOT be retried.
 * Requirements: 8.2
 */
export class PaymentError extends Error {
  readonly code: "PAYMENT_ERROR" = "PAYMENT_ERROR";
  readonly httpStatus?: number;

  constructor(message: string, httpStatus?: number) {
    super(message);
    this.name = "PaymentError";
    this.httpStatus = httpStatus;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when the LLM response content fails validation (null, undefined, or length ≤ 50 chars).
 * Distinct from an API-level failure — indicates the API call succeeded but the content is unusable.
 * Must NOT be retried.
 * Requirements: 6.3, 6.5
 */
export class ContentValidationError extends Error {
  readonly code: "CONTENT_VALIDATION_ERROR" = "CONTENT_VALIDATION_ERROR";
  readonly contentLength?: number;

  constructor(message: string, contentLength?: number) {
    super(message);
    this.name = "ContentValidationError";
    this.contentLength = contentLength;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when SAP agent registration fails (e.g., transaction rejected, account creation error).
 * Requirements: 2.6
 */
export class RegistrationError extends Error {
  readonly code: "REGISTRATION_ERROR" = "REGISTRATION_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "RegistrationError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when `agent.run(topic)` is called with a topic that is already being processed
 * in an active pipeline run, preventing duplicate concurrent runs for the same topic.
 * Requirements: 9.2 (DuplicateRunError guard in run())
 */
export class DuplicateRunError extends Error {
  readonly code: "DUPLICATE_RUN" = "DUPLICATE_RUN";

  constructor(topic: string) {
    super(
      `A pipeline run for topic "${topic}" is already in progress. Wait for the current run to complete before starting a new one.`
    );
    this.name = "DuplicateRunError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when the Ace Data Cloud Midjourney image generation API does not return
 * a result within the expected timeout duration.
 * Requirements: 7.3
 */
export class ImageGenerationTimeoutError extends Error {
  readonly code: "IMAGE_GENERATION_TIMEOUT" = "IMAGE_GENERATION_TIMEOUT";
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(
      `Image generation timed out after ${timeoutMs}ms. The Midjourney task did not complete within the allowed time window.`
    );
    this.name = "ImageGenerationTimeoutError";
    this.timeoutMs = timeoutMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
