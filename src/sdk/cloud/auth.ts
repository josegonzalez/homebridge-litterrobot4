/**
 * Whisker account sign in, through the AWS Cognito user pool the Whisker app
 * uses. The details follow pylitterbot (MIT), the library behind the Home
 * Assistant integration: https://github.com/natekspencer/pylitterbot
 */

export const COGNITO_ENDPOINT = 'https://cognito-idp.us-east-1.amazonaws.com/';
export const COGNITO_CLIENT_ID = '4552ujeu3aic90nf8qn53levmn';

/** Tokens for a signed in account. */
export interface Tokens {
  idToken: string;
  refreshToken?: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
}

/** Cognito rejected the credentials or the refresh token. */
export class AuthError extends Error {
  constructor(
    readonly type: string,
    message: string,
  ) {
    super(message ? `Whisker sign in failed: ${message}` : `Whisker sign in failed: ${type}`);
    this.name = 'AuthError';
  }
}

export interface AuthOptions {
  email?: string;
  password?: string;
  tokens?: Partial<Tokens>;
  /** Called with new tokens, so they can be cached. */
  onTokens?: (tokens: Tokens) => void;
  /** Overrides the Cognito endpoint, for tests. */
  endpoint?: string;
  fetch?: typeof fetch;
}

/** Decodes a JWT payload without checking its signature. */
export function jwtClaims(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('malformed token');
  }
  return JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
}

/** The Whisker user ID (the "mid" claim) in an ID token. */
export function userIdFromToken(idToken: string): string {
  const mid = jwtClaims(idToken).mid;
  if (typeof mid === 'string') {
    return mid;
  }
  if (typeof mid === 'number') {
    return String(mid);
  }
  throw new Error('token has no mid claim');
}

/** Signs in to Cognito and keeps the ID token fresh. */
export class WhiskerAuth {
  email?: string;
  password?: string;
  private tokens?: Tokens;
  private refreshing?: Promise<Tokens>;
  private readonly onTokens?: (tokens: Tokens) => void;
  private readonly endpoint: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: AuthOptions = {}) {
    this.email = options.email;
    this.password = options.password;
    this.onTokens = options.onTokens;
    this.endpoint = options.endpoint ?? COGNITO_ENDPOINT;
    this.fetchFn = options.fetch ?? fetch;
    if (options.tokens?.idToken || options.tokens?.refreshToken) {
      this.tokens = {
        idToken: options.tokens.idToken ?? '',
        refreshToken: options.tokens.refreshToken,
        expiresAt: options.tokens.expiresAt ?? 0,
      };
    }
  }

  /** Signs in with an email and password. */
  async login(email = this.email, password = this.password): Promise<Tokens> {
    if (!email || !password) {
      throw new AuthError('MissingCredentials', 'an email and password are required');
    }
    const tokens = await this.initiate('USER_PASSWORD_AUTH', { USERNAME: email, PASSWORD: password });
    this.email = email;
    this.password = password;
    this.set(tokens);
    return tokens;
  }

  /** Returns a valid ID token, refreshing it when it expires within 30 seconds. */
  async idToken(): Promise<string> {
    if (this.tokens?.idToken && this.tokens.expiresAt - Date.now() > 30_000) {
      return this.tokens.idToken;
    }
    return (await this.refresh()).idToken;
  }

  /** The user ID of the signed in account. */
  async userId(): Promise<string> {
    return userIdFromToken(await this.idToken());
  }

  /** Gets a new ID token now, with the refresh token or else the password. */
  refresh(): Promise<Tokens> {
    this.refreshing ??= this.doRefresh().finally(() => (this.refreshing = undefined));
    return this.refreshing;
  }

  private async doRefresh(): Promise<Tokens> {
    let refreshError: unknown;
    if (this.tokens?.refreshToken) {
      try {
        const tokens = await this.initiate('REFRESH_TOKEN_AUTH', { REFRESH_TOKEN: this.tokens.refreshToken });
        tokens.refreshToken ??= this.tokens.refreshToken;
        this.set(tokens);
        return tokens;
      } catch (err) {
        if (!(err instanceof AuthError)) {
          throw err;
        }
        refreshError = err;
      }
    }
    if (!this.email || !this.password) {
      throw refreshError ?? new AuthError('NotSignedIn', 'not signed in');
    }
    return this.login();
  }

  private set(tokens: Tokens): void {
    this.tokens = tokens;
    this.onTokens?.(tokens);
  }

  private async initiate(flow: string, params: Record<string, string>): Promise<Tokens> {
    const response = await this.fetchFn(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth',
      },
      body: JSON.stringify({ AuthFlow: flow, ClientId: COGNITO_CLIENT_ID, AuthParameters: params }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // handled below
    }
    if (!response.ok) {
      const type = typeof body.__type === 'string' ? body.__type : '';
      if (!type) {
        throw new Error(`Cognito: HTTP ${response.status}`);
      }
      throw new AuthError(type, typeof body.message === 'string' ? body.message : '');
    }
    const result = body.AuthenticationResult as { IdToken?: string; RefreshToken?: string; ExpiresIn?: number } | undefined;
    if (!result?.IdToken) {
      if (typeof body.ChallengeName === 'string') {
        throw new AuthError(body.ChallengeName, `Cognito asked for ${body.ChallengeName}, which is not supported`);
      }
      throw new Error('Cognito: no tokens in response');
    }
    let expiresAt = Date.now() + (result.ExpiresIn ?? 3600) * 1000;
    const exp = jwtClaims(result.IdToken).exp;
    if (typeof exp === 'number') {
      expiresAt = exp * 1000;
    }
    return { idToken: result.IdToken, refreshToken: result.RefreshToken, expiresAt };
  }
}
