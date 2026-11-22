/** Caches Whisker tokens in the Homebridge storage folder, so restarts do not need a new sign in. */
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Tokens } from './sdk/index.js';

export const TOKEN_FILE = 'litterrobot4-tokens.json';

interface CacheFile {
  email: string;
  tokens: Tokens;
}

export class TokenCache {
  readonly path: string;

  constructor(storagePath: string) {
    this.path = join(storagePath, TOKEN_FILE);
  }

  /** The cached tokens for an email, if any. */
  load(email: string): Tokens | undefined {
    try {
      const data = JSON.parse(readFileSync(this.path, 'utf8')) as CacheFile;
      return data.email?.toLowerCase() === email.toLowerCase() ? data.tokens : undefined;
    } catch {
      return undefined;
    }
  }

  /** Saves tokens, readable only by the Homebridge user. */
  save(email: string, tokens: Tokens): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ email, tokens } satisfies CacheFile), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }
}
