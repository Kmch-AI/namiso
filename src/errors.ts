export class NamisoError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NamisoError";
    this.code = code;
  }
}

export class ValidationError extends NamisoError {
  constructor(message: string) {
    super("validation", message);
    this.name = "ValidationError";
  }
}

export class NotFoundError extends NamisoError {
  constructor(kind: string, id: string) {
    super("not_found", `${kind} not found: ${id}`);
    this.name = "NotFoundError";
  }
}

export class ProviderError extends NamisoError {
  constructor(message: string, options?: ErrorOptions) {
    super("provider", message, options);
    this.name = "ProviderError";
  }
}
