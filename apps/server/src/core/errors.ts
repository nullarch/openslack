/** An error that becomes `{ ok: false, error: code, ...extra }` in the API response. */
export class ApiError extends Error {
  readonly code: string;
  readonly extra: Record<string, unknown>;
  readonly status: number;

  constructor(code: string, extra: Record<string, unknown> = {}, status = 200) {
    super(code);
    this.code = code;
    this.extra = extra;
    this.status = status;
  }
}

export function fail(code: string, extra: Record<string, unknown> = {}): never {
  throw new ApiError(code, extra);
}
