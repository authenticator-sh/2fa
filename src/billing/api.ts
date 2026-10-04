// The only code in the extension that talks to the billing server.
//
// Every call has a timeout and none is retried here: a request that fails is
// made again at the next natural moment (the next popup open, the next sync),
// never in a loop while the person waits.

import { API_ORIGIN } from './config';
import type { ApiErrorCode } from './types';

export class BillingApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    readonly status: number,
  ) {
    super(`billing api: ${code} (${status})`);
    this.name = 'BillingApiError';
  }
}

const KNOWN: readonly ApiErrorCode[] = [
  'bad_request',
  'rate_limited',
  'unknown_install',
  'plan_unavailable',
  'invalid_key',
  'license_inactive',
  'device_limit',
  'no_license',
  'payments_unavailable',
  'price_changed',
  'internal',
];

async function request<T>(method: 'GET' | 'POST', path: string, body: unknown, timeoutMs: number): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_ORIGIN}${path}`, {
      method,
      // JSON in a text/plain body, on purpose: application/json would make
      // every call a CORS preflight — an OPTIONS before each daily sync, since
      // Chrome keeps a preflight for two hours at most — doubling the requests
      // the API is billed for. The server parses the body whatever its type.
      headers: body === undefined ? undefined : { 'Content-Type': 'text/plain' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new BillingApiError('network', 0);
  }
  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    // A proxy's HTML error page, or nothing at all.
  }
  if (!response.ok) {
    const code = (data as { error?: unknown } | null)?.error;
    throw new BillingApiError(KNOWN.includes(code as ApiErrorCode) ? (code as ApiErrorCode) : 'internal', response.status);
  }
  return data as T;
}

export function post<T>(path: string, body: unknown, timeoutMs = 10_000): Promise<T> {
  return request<T>('POST', path, body, timeoutMs);
}
