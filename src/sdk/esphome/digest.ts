/** HTTP digest authentication (RFC 7616), as the ESPHome web server uses. */
import { createHash, randomBytes } from 'node:crypto';

/** Parses the parameters of a WWW-Authenticate challenge. Values may be quoted and contain commas. */
export function parseChallenge(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]*))/g;
  for (const m of header.matchAll(re)) {
    out[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? '';
  }
  return out;
}

export interface DigestChallenge {
  realm: string;
  nonce: string;
  qop?: string;
  algorithm?: string;
  opaque?: string;
}

/** Keeps a digest challenge and builds Authorization headers for it. */
export class DigestAuth {
  private challenge?: DigestChallenge;
  private basic = false;
  private nc = 0;

  constructor(
    private readonly username: string,
    private readonly password: string,
  ) {}

  /** Records a challenge from a 401 response. Returns false if the scheme is not supported. */
  accept(header: string | null): boolean {
    if (!header) {
      return false;
    }
    const [scheme] = header.split(' ', 1);
    if (scheme!.toLowerCase() === 'basic') {
      this.basic = true;
      return true;
    }
    if (scheme!.toLowerCase() !== 'digest') {
      return false;
    }
    const p = parseChallenge(header.slice(scheme!.length));
    this.challenge = { realm: p.realm ?? '', nonce: p.nonce ?? '', qop: p.qop, algorithm: p.algorithm, opaque: p.opaque };
    this.basic = false;
    this.nc = 0;
    return true;
  }

  /** The Authorization header for a request, or undefined before a challenge was seen. */
  header(method: string, uri: string): string | undefined {
    if (this.basic) {
      return `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`;
    }
    const c = this.challenge;
    if (!c) {
      return undefined;
    }
    const algorithm = (c.algorithm ?? 'MD5').toUpperCase();
    const hashName = algorithm === 'SHA-256' ? 'sha256' : algorithm === 'MD5' ? 'md5' : undefined;
    if (!hashName) {
      throw new Error(`unsupported digest algorithm ${c.algorithm}`);
    }
    const h = (s: string) => createHash(hashName).update(s).digest('hex');
    const ha1 = h(`${this.username}:${c.realm}:${this.password}`);
    const ha2 = h(`${method}:${uri}`);
    const parts = [`username="${this.username}"`, `realm="${c.realm}"`, `nonce="${c.nonce}"`, `uri="${uri}"`];
    const qop = c.qop
      ?.split(',')
      .map((q) => q.trim())
      .includes('auth')
      ? 'auth'
      : undefined;
    let response: string;
    if (qop) {
      this.nc++;
      const nc = this.nc.toString(16).padStart(8, '0');
      const cnonce = randomBytes(8).toString('hex');
      response = h(`${ha1}:${c.nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
      parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
    } else {
      response = h(`${ha1}:${c.nonce}:${ha2}`);
    }
    parts.push(`response="${response}"`);
    if (c.algorithm) {
      parts.push(`algorithm=${c.algorithm}`);
    }
    if (c.opaque !== undefined) {
      parts.push(`opaque="${c.opaque}"`);
    }
    return `Digest ${parts.join(', ')}`;
  }
}
