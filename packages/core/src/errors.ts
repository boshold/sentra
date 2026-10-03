export interface SentraErrorOptions {
  details?: unknown;
  cause?: unknown;
}

export class SentraError extends Error {
  public readonly code: string;
  public readonly details?: unknown;

  public constructor(code: string, message: string, options?: SentraErrorOptions) {
    super(message, options && "cause" in options ? { cause: options.cause } : undefined);
    this.name = "SentraError";
    this.code = code;
    if (options && "details" in options) {
      this.details = options.details;
    }
  }
}

export type SentraValidationErrorCode = "invalid_filter" | "invalid_cursor";

export class SentraValidationError extends SentraError {
  declare public readonly code: SentraValidationErrorCode;

  public constructor(
    code: SentraValidationErrorCode,
    message: string,
    options?: SentraErrorOptions,
  ) {
    super(code, message, options);
    this.name = "SentraValidationError";
  }
}

export type SentraConfigErrorCode = "missing_public_url" | "invalid_option";

export class SentraConfigError extends SentraError {
  declare public readonly code: SentraConfigErrorCode;

  public constructor(code: SentraConfigErrorCode, message: string, options?: SentraErrorOptions) {
    super(code, message, options);
    this.name = "SentraConfigError";
  }
}

export type SentraStorageErrorCode = "storage_unavailable" | "schema_too_new";

export class SentraStorageError extends SentraError {
  declare public readonly code: SentraStorageErrorCode;

  public constructor(code: SentraStorageErrorCode, message: string, options?: SentraErrorOptions) {
    super(code, message, options);
    this.name = "SentraStorageError";
  }
}

export class SentraScopeError extends SentraError {
  declare public readonly code: "invalid_scope";

  public constructor(message: string, options?: SentraErrorOptions) {
    super("invalid_scope", message, options);
    this.name = "SentraScopeError";
  }
}

export class SentraTooLargeError extends SentraError {
  declare public readonly code: "payload_too_large";

  public constructor(message: string, options?: SentraErrorOptions) {
    super("payload_too_large", message, options);
    this.name = "SentraTooLargeError";
  }
}

export class SentraEncodingError extends SentraError {
  declare public readonly code: "unsupported_encoding";

  public constructor(message: string, options?: SentraErrorOptions) {
    super("unsupported_encoding", message, options);
    this.name = "SentraEncodingError";
  }
}
