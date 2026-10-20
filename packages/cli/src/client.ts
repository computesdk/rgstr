// Auth resolution + the JSON client every command uses. Mirrors
// packages/cli/src/actions-client.ts: explicit token > RGSTR_TOKEN > the
// stored device login; untrusted hosts need --allow-untrusted-host and never
// see stored credentials; http:// only for loopback.

import { refreshAccessToken, AuthError } from './auth.js';
import { loadConfig, loadCredentials, saveCredentials, type Credentials } from './config.js';
import { isSecureTransport, isTrustedHost } from './hosts.js';

export const DEFAULT_BASE_URL = 'https://rgstr.org';

export type RgstrCliErrorCode =
  | 'no_credentials'
  | 'untrusted_host'
  | 'untrusted_host_stored_auth'
  | 'insecure_transport'
  | 'invalid_argument'
  | 'not_found'
  | 'not_holder'
  | 'not_configured'
  | 'conflict';

export class RgstrCliError extends Error {
  constructor(
    public code: RgstrCliErrorCode,
    message: string,
    /** The next step, printed last, like an API error's `hint`. */
    public hint?: string,
  ) {
    super(message);
    this.name = 'RgstrCliError';
  }
}

/** What rgstr.org answers with on every failure: `code` to branch on, `hint`
 *  the next step (follow it), `requestId` to quote when reporting a problem. */
export interface ApiErrorBody {
  error?: string;
  code?: string;
  hint?: string;
  requestId?: string;
  details?: unknown;
}

export class RgstrApiError extends Error {
  /** Stable machine-readable code from the API (`not_signed_in`, `claim_pending`, …). */
  readonly code: string | undefined;
  /** The next step, as the API said it. */
  readonly hint: string | undefined;
  readonly requestId: string | undefined;
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
    this.name = 'RgstrApiError';
    const b = body && typeof body === 'object' ? (body as ApiErrorBody) : {};
    this.code = typeof b.code === 'string' ? b.code : undefined;
    this.hint = typeof b.hint === 'string' ? b.hint : undefined;
    this.requestId = typeof b.requestId === 'string' ? b.requestId : undefined;
  }
  /** `details` the API attached (a check-proof's outcome, a validation list). */
  get details(): unknown {
    return this.body && typeof this.body === 'object' ? (this.body as ApiErrorBody).details : undefined;
  }
}

export { isSecureTransport, isTrustedHost } from './hosts.js';

export function normalizeBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, '');
}

export interface GlobalOptions {
  baseUrl?: string;
  allowUntrustedHost?: boolean;
  org?: string;
  token?: string;
  json?: boolean;
}

export interface ResolvedAuth {
  baseUrl: string;
  token: string | null;
  kind: 'api_key' | 'device' | 'none';
  org: string | null;
  credentials?: Credentials;
}

/** Where the CLI points by default: flag > RGSTR_URL > saved config > rgstr.org. */
export async function resolveBaseUrl(opts: { baseUrl?: string }): Promise<string> {
  const cfg = await loadConfig();
  return normalizeBaseUrl(opts.baseUrl || process.env.RGSTR_URL || cfg.baseUrl || DEFAULT_BASE_URL);
}

export function assertHostAllowed(baseUrl: string, allowUntrustedHost?: boolean): void {
  if (!allowUntrustedHost && !isTrustedHost(baseUrl)) {
    throw new RgstrCliError(
      'untrusted_host',
      `Refusing to talk to ${baseUrl} — it is not rgstr.org, computesdk.com or a localhost host. ` +
        'If this is a self-hosted/dev deployment you trust, pass --allow-untrusted-host.',
    );
  }
  if (!isSecureTransport(baseUrl)) {
    throw new RgstrCliError(
      'insecure_transport',
      `Refusing to send credentials over plaintext HTTP to ${baseUrl}. ` +
        'Use an https:// base URL; http:// is only allowed for localhost/loopback.',
    );
  }
}

/**
 * Pick the credential for this invocation. Public commands pass
 * `{ optional: true }` and get `kind: 'none'` instead of an error.
 */
export async function resolveAuth(
  opts: GlobalOptions & { optional?: boolean },
  io: { loadCredentials?: typeof loadCredentials; fetchImpl?: typeof fetch } = {},
): Promise<ResolvedAuth> {
  const baseUrl = await resolveBaseUrl(opts);
  assertHostAllowed(baseUrl, opts.allowUntrustedHost);
  const cfg = await loadConfig();
  const org = opts.org || process.env.RGSTR_ORG || cfg.org || null;

  const explicit = opts.token || process.env.RGSTR_TOKEN || undefined;
  if (explicit) return { baseUrl, token: explicit, kind: 'api_key', org };

  // Stored device logins are bound to the origin they were made against and
  // are never replayed to an untrusted host, even with --allow-untrusted-host.
  if (isTrustedHost(baseUrl)) {
    const stored = await (io.loadCredentials ?? loadCredentials)();
    if (stored && normalizeBaseUrl(stored.baseUrl) === baseUrl) {
      try {
        const fresh = await ensureFresh(stored, io.fetchImpl ?? fetch);
        return { baseUrl, token: fresh.token, kind: 'device', org, credentials: fresh };
      } catch (err) {
        // A dead login must not break public commands; they just go anonymous.
        if (!(opts.optional && err instanceof RgstrCliError && err.code === 'no_credentials')) throw err;
      }
    }
  }

  if (opts.optional) return { baseUrl, token: null, kind: 'none', org };
  throw new RgstrCliError(
    'no_credentials',
    isTrustedHost(baseUrl)
      ? 'Not logged in. Run `rgstr login`, or set RGSTR_TOKEN to an organization API key.'
      : `No credentials for ${baseUrl}: stored logins are not sent to untrusted hosts. Set RGSTR_TOKEN explicitly.`,
  );
}

async function ensureFresh(stored: Credentials, fetchImpl: typeof fetch): Promise<Credentials> {
  const expiresSoon = stored.tokenExpiresAt && stored.tokenExpiresAt - Date.now() < 60_000;
  if (!expiresSoon || !stored.refreshToken) return stored;
  try {
    const t = await refreshAccessToken({ authBaseUrl: stored.authBaseUrl, resource: stored.resource }, stored.refreshToken, stored.clientId, fetchImpl);
    const next: Credentials = {
      ...stored,
      token: t.access_token,
      refreshToken: t.refresh_token ?? stored.refreshToken,
      tokenExpiresAt: Date.now() + t.expires_in * 1000,
    };
    await saveCredentials(next);
    return next;
  } catch (err) {
    if (err instanceof AuthError) {
      throw new RgstrCliError('no_credentials', `Your login has expired (${err.message}). Run \`rgstr login\` again.`);
    }
    throw err;
  }
}

export class RgstrClient {
  constructor(
    public readonly auth: ResolvedAuth,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get baseUrl(): string {
    return this.auth.baseUrl;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.auth.token) headers.authorization = `Bearer ${this.auth.token}`;
    if (this.auth.org) headers['x-org-slug'] = this.auth.org;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await this.fetchImpl(`${this.auth.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      // Never let a redirect carry the bearer token to another host.
      redirect: 'manual',
    });
    if (res.status >= 300 && res.status < 400) {
      throw new RgstrApiError(res.status, `Unexpected redirect from ${this.auth.baseUrl}${path} to ${res.headers.get('location') ?? '?'}; refusing to follow with credentials`);
    }
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    if (!res.ok) {
      const message =
        (parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string'
          ? (parsed as { error: string }).error
          : null) ?? `${res.status} ${res.statusText}`;
      throw new RgstrApiError(res.status, message, parsed);
    }
    return parsed as T;
  }

  get<T>(path: string) {
    return this.request<T>('GET', path);
  }
  post<T>(path: string, body?: unknown) {
    return this.request<T>('POST', path, body ?? {});
  }
  put<T>(path: string, body: unknown) {
    return this.request<T>('PUT', path, body);
  }
}

/** Shape commands print when something goes wrong; same envelope as `compute`
 *  and as the API itself: `code` to branch on, `hint` the next step. */
export interface ErrorEnvelope {
  error: string;
  code?: string;
  hint?: string;
  status?: number;
  requestId?: string;
}

export function toErrorEnvelope(err: unknown): ErrorEnvelope {
  if (err instanceof RgstrCliError) return { error: err.message, code: err.code, ...(err.hint ? { hint: err.hint } : {}) };
  if (err instanceof RgstrApiError) {
    return {
      error: err.message,
      status: err.status,
      ...(err.code ? { code: err.code } : {}),
      ...(err.hint ? { hint: err.hint } : {}),
      ...(err.requestId ? { requestId: err.requestId } : {}),
    };
  }
  if (err instanceof Error) return { error: err.message };
  return { error: String(err) };
}

/** The lines a person reads for a failure: the message, then the next step last. */
export function renderError(env: ErrorEnvelope): string {
  return env.hint ? `Error: ${env.error}\n${env.hint}` : `Error: ${env.error}`;
}
