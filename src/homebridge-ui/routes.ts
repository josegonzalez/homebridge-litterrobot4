/** Route handlers for the settings UI server, kept separate so they can be tested. */
import { RequestError } from '@homebridge/plugin-ui-utils';

import {
  AuthError,
  discover,
  ESPHomeRobot,
  parseRobot,
  UnauthorizedError,
  WhiskerAuth,
  WhiskerClient,
} from '../sdk/index.js';

export interface AccountRequest {
  email?: string;
  password?: string;
}

export interface AccountRobot {
  serial: string;
  name: string;
  status: string;
  online: boolean;
}

export interface VerifyRequest {
  host?: string;
  username?: string;
  password?: string;
}

/** Endpoints, overridable for tests. */
export interface RouteOptions {
  cognitoEndpoint?: string;
  graphqlEndpoint?: string;
}

/** Signs in with the given credentials and lists the account's robots. */
export async function accountRobots(body: AccountRequest, options: RouteOptions = {}): Promise<AccountRobot[]> {
  const email = body.email?.trim();
  if (!email || !body.password) {
    throw new RequestError('Enter your Whisker email and password first.', { code: 'missing' });
  }
  const auth = new WhiskerAuth({ email, password: body.password, endpoint: options.cognitoEndpoint });
  try {
    await auth.login();
    const client = new WhiskerClient({ auth, endpoint: options.graphqlEndpoint });
    const robots = await client.robots();
    return robots.map((data) => {
      const s = parseRobot(data);
      return { serial: s.serial ?? '', name: s.name ?? '', status: s.status.text, online: s.online };
    });
  } catch (err) {
    if (err instanceof AuthError) {
      throw new RequestError(err.message, { code: 'auth' });
    }
    throw new RequestError(err instanceof Error ? err.message : String(err), { code: 'error' });
  }
}

export async function discoverRobots() {
  const robots = await discover({ timeoutMs: 4000 });
  return robots.map((r) => ({ name: r.name, host: r.host, address: r.address, mac: r.mac }));
}

/** Checks that an ESPHome robot answers and accepts the web server credentials. */
export async function verifyESPHome(body: VerifyRequest) {
  const host = body.host?.trim();
  if (!host) {
    throw new RequestError('A host is required.', { code: 'host' });
  }
  const robot = new ESPHomeRobot({ host, username: body.username?.trim() || undefined, password: body.password || undefined, timeoutMs: 5000 });
  try {
    const state = await robot.getState();
    return { status: state.status.text, litterLevel: state.litterLevel, wasteLevel: state.wasteLevel };
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      throw new RequestError('The robot rejected the username or password.', { code: 'rejected' });
    }
    throw new RequestError(err instanceof Error ? err.message : String(err), { code: 'error' });
  }
}
