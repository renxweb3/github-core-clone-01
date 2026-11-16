// types.ts — the request/response shapes the HTTP layer and the handlers share.

import type { IncomingHttpHeaders } from 'node:http';
import type { Store } from './store.ts';

export interface ReqCtx {
  readonly store: Store;
  readonly method: string;
  readonly pathname: string;
  readonly query: URLSearchParams;
  readonly headers: IncomingHttpHeaders;
  /** The request's own origin (http://host), for absolute Link URLs. */
  readonly origin: string;
  /** Raw request body (empty for GETs). */
  readonly body: Buffer;
  /** Parsed JSON body when the content type is JSON and it parsed, else undefined. */
  readonly json: unknown;
  /** True when a JSON body was sent but did not parse. */
  readonly jsonError: boolean;
  /** True when the Authorization header carries the entry's token. */
  readonly authed: boolean;
  readonly requestId: string;
}

export interface Resp {
  readonly status: number;
  /** Object -> JSON, Buffer -> raw bytes, string -> raw text, undefined -> empty body. */
  readonly body?: unknown;
  readonly contentType?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/** A JSON 404 body. */
export function notFound(message = 'Not Found'): Resp {
  return { status: 404, body: { message } };
}

/** A JSON error body with a message. */
export function errorResp(status: number, message: string): Resp {
  return { status, body: { message } };
}

/** 401 for a missing or wrong token. */
export function unauthorized(): Resp {
  return { status: 401, body: { message: 'Requires authentication' } };
}
