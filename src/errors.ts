import type {HmIPHttpError, HmIPHttpErrorKind} from './http-client.js';

export type HmIPClientErrorKind = HmIPHttpErrorKind | 'invalid-response' | 'event-buffer-full' | 'command-rejected';

/** Safe to log: never contains request bodies, credentials, or response payloads. */
export class HmIPClientError extends Error {
  override readonly name = 'HmIPClientError';
  constructor(
    public readonly kind: HmIPClientErrorKind,
    public readonly path: string,
    public readonly status?: number,
  ) {
    super(`Homematic IP ${kind}: ${path}${status === undefined ? '' : ` (HTTP ${status})`}`);
  }

  static fromHttp(error: HmIPHttpError): HmIPClientError {
    return new HmIPClientError(error.kind, error.path, error.status);
  }
}
