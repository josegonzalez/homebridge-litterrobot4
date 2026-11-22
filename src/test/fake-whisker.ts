/** A fake Cognito and Whisker GraphQL server for tests. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const TEST_EMAIL = 'cat@example.com';
export const TEST_PASSWORD = 'meow';
export const TEST_USER_ID = '1234567';

export function fakeJwt(claims: Record<string, unknown>): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc(claims)}.sig`;
}

/** Raw robot data like the real API returns, from a real Litter-Robot 4. */
export function robotData(serial: string, name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    unitId: serial.slice(-4),
    serial,
    name,
    userId: TEST_USER_ID,
    isOnline: true,
    unitPowerStatus: 'ON',
    unitPowerType: 'AC',
    robotStatus: 'ROBOT_IDLE',
    robotCycleState: 'CYCLE_STATE_WAIT_ON',
    displayCode: 'DC_MODE_IDLE',
    catDetect: 'CAT_DETECT_CLEAR',
    litterLevel: 466,
    litterLevelPercentage: 0.68,
    litterLevelState: 'LOW',
    DFILevelPercent: 59,
    isDFIFull: false,
    catWeight: 8.78,
    nightLightMode: 'OFF',
    nightLightBrightness: 25,
    panelBrightnessHigh: 25,
    isKeypadLockout: false,
    cleanCycleWaitTime: 7,
    sleepStatus: 'WAKE',
    odometerCleanCycles: 968,
    wifiRssi: -20,
    espFirmware: '1.1.75',
    picFirmwareVersion: '10500.3072.2.93',
    laserBoardFirmwareVersion: '5.0.2.1',
    lastSeen: '2026-11-06T03:45:36.867Z',
    ...extra,
  };
}

export interface Command {
  serial: string;
  command: string;
  value?: string;
  commandSource?: string;
}

export class FakeWhisker {
  robots: Record<string, unknown>[] = [robotData('LR4C000001', 'Upstairs'), robotData('LR4C000002', 'Basement')];
  commands: Command[] = [];
  logins = 0;
  refreshes = 0;
  /** Number of upcoming GraphQL requests to fail with HTTP 500. */
  failNext = 0;
  /** Make the next GraphQL request return 401. */
  expireNext = false;
  /** Applied to robots on the next requestState, like a robot reporting in. */
  pending = new Map<string, Record<string, unknown>>();
  private validToken = '';
  private server?: Server;

  get url(): string {
    return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  get cognito(): string {
    return `${this.url}/cognito`;
  }

  get graphql(): string {
    return `${this.url}/graphql`;
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    return this;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<string, any>;
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };

    if (req.url === '/cognito') {
      const p = body.AuthParameters ?? {};
      if (body.AuthFlow === 'USER_PASSWORD_AUTH') {
        if (p.USERNAME !== TEST_EMAIL || p.PASSWORD !== TEST_PASSWORD) {
          return send(400, { __type: 'NotAuthorizedException', message: 'Incorrect username or password.' });
        }
        this.logins++;
      } else if (body.AuthFlow === 'REFRESH_TOKEN_AUTH') {
        if (p.REFRESH_TOKEN !== 'refresh-1') {
          return send(400, { __type: 'NotAuthorizedException', message: 'Refresh Token has expired' });
        }
        this.refreshes++;
      }
      this.validToken = fakeJwt({ mid: Number(TEST_USER_ID), exp: Math.floor(Date.now() / 1000) + 3600, n: this.logins + this.refreshes });
      const result: Record<string, unknown> = { IdToken: this.validToken, ExpiresIn: 3600 };
      if (body.AuthFlow === 'USER_PASSWORD_AUTH') result.RefreshToken = 'refresh-1';
      return send(200, { AuthenticationResult: result });
    }

    if (this.expireNext) {
      this.expireNext = false;
      return send(401, { message: 'expired' });
    }
    if (req.headers.authorization !== `Bearer ${this.validToken}`) {
      return send(401, { message: 'Unauthorized' });
    }
    if (this.failNext > 0) {
      this.failNext--;
      return send(500, { message: 'boom' });
    }
    const q: string = body.query ?? '';
    const v: Record<string, any> = body.variables ?? {};
    if (q.includes('getLitterRobot4ByUser')) {
      if (v.userId !== TEST_USER_ID) return send(200, { data: { getLitterRobot4ByUser: [] } });
      return send(200, { data: { getLitterRobot4ByUser: this.robots } });
    }
    if (q.includes('getLitterRobot4BySerial')) {
      return send(200, { data: { getLitterRobot4BySerial: this.robots.find((r) => r.serial === v.serial) ?? null } });
    }
    if (q.includes('sendLitterRobot4Command')) {
      this.commands.push({ serial: v.serial, command: v.command, value: v.value, commandSource: v.commandSource });
      if (v.command === 'bogus') return send(200, { data: { sendLitterRobot4Command: 'Error sending command' } });
      const robot = this.robots.find((r) => r.serial === v.serial);
      if (v.command === 'requestState' && robot && this.pending.has(v.serial)) {
        Object.assign(robot, this.pending.get(v.serial));
        this.pending.delete(v.serial);
      }
      return send(200, { data: { sendLitterRobot4Command: 'command sent' } });
    }
    if (q.includes('broken')) {
      return send(200, { data: null, errors: [{ message: 'Validation error' }] });
    }
    return send(400, { message: `unexpected query ${q}` });
  }
}
