/**
 * Custom error classes for the Autonomous Bounty Agent.
 * Each error extends Error with a typed `code` property for programmatic handling.
 */
/**
 * Thrown when one or more required environment variables are missing or empty.
 * Requirements: 14.2
 */
export declare class ConfigurationError extends Error {
    readonly code: "CONFIGURATION_ERROR";
    constructor(missingVars: string[]);
}
/**
 * Thrown when the keypair file is missing or does not contain a valid 64-byte Solana keypair.
 * NEVER includes raw key bytes in the message.
 * Requirements: 1.4, 1.5
 */
export declare class InvalidKeypairError extends Error {
    readonly code: "INVALID_KEYPAIR";
    constructor(message: string);
}
/**
 * Thrown when the wallet's SOL balance is below the minimum required threshold (0.015 SOL).
 * Requirements: 13.1
 */
export declare class InsufficientSolError extends Error {
    readonly code: "INSUFFICIENT_SOL";
    constructor(currentBalance: number, requiredBalance: number);
}
/**
 * Thrown when the wallet's USDC SPL token balance is below the minimum required threshold (0.50 USDC).
 * Requirements: 13.2
 */
export declare class InsufficientUsdcError extends Error {
    readonly code: "INSUFFICIENT_USDC";
    constructor(currentBalance: number, requiredBalance: number);
}
/**
 * Thrown when the wallet's USDC balance is insufficient to cover a specific x402 payment.
 * Must NOT be retried — thrown immediately before signing the payment envelope.
 * Requirements: 8.5, 12.3
 */
export declare class InsufficientFundsError extends Error {
    readonly code: "INSUFFICIENT_FUNDS";
    constructor(requiredAmount: number, availableAmount: number);
}
/**
 * Thrown when an x402 payment handshake fails (e.g., max retries exceeded, missing x402_tx header,
 * or no Solana-compatible payment option in the 402 accepts array).
 * Must NOT be retried.
 * Requirements: 8.2
 */
export declare class PaymentError extends Error {
    readonly code: "PAYMENT_ERROR";
    readonly httpStatus?: number;
    constructor(message: string, httpStatus?: number);
}
/**
 * Thrown when the LLM response content fails validation (null, undefined, or length ≤ 50 chars).
 * Distinct from an API-level failure — indicates the API call succeeded but the content is unusable.
 * Must NOT be retried.
 * Requirements: 6.3, 6.5
 */
export declare class ContentValidationError extends Error {
    readonly code: "CONTENT_VALIDATION_ERROR";
    readonly contentLength?: number;
    constructor(message: string, contentLength?: number);
}
/**
 * Thrown when SAP agent registration fails (e.g., transaction rejected, account creation error).
 * Requirements: 2.6
 */
export declare class RegistrationError extends Error {
    readonly code: "REGISTRATION_ERROR";
    constructor(message: string);
}
/**
 * Thrown when `agent.run(topic)` is called with a topic that is already being processed
 * in an active pipeline run, preventing duplicate concurrent runs for the same topic.
 * Requirements: 9.2 (DuplicateRunError guard in run())
 */
export declare class DuplicateRunError extends Error {
    readonly code: "DUPLICATE_RUN";
    constructor(topic: string);
}
/**
 * Thrown when the Ace Data Cloud Midjourney image generation API does not return
 * a result within the expected timeout duration.
 * Requirements: 7.3
 */
export declare class ImageGenerationTimeoutError extends Error {
    readonly code: "IMAGE_GENERATION_TIMEOUT";
    readonly timeoutMs: number;
    constructor(timeoutMs: number);
}
//# sourceMappingURL=errors.d.ts.map