import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { fakeJwt, FakeWhisker, TEST_EMAIL, TEST_PASSWORD } from '../../test/fake-whisker.js';
import { AuthError, userIdFromToken, WhiskerAuth } from './auth.js';
import { COMMAND_SOURCE, GraphQLError, NotConfirmedError, WhiskerClient } from './client.js';

let fake: FakeWhisker;
before(async () => (fake = await new FakeWhisker().start()));
after(() => fake.stop());
beforeEach(() => {
  fake.commands = [];
  fake.logins = 0;
  fake.refreshes = 0;
});

const client = (opts: ConstructorParameters<typeof WhiskerAuth>[0] = {}) =>
  new WhiskerClient({ auth: new WhiskerAuth({ endpoint: fake.cognito, ...opts }), endpoint: fake.graphql });

describe('WhiskerAuth', () => {
  it('signs in, and reports a bad password', async () => {
    await assert.rejects(new WhiskerAuth({ endpoint: fake.cognito }).login(TEST_EMAIL, 'nope'), (err: unknown) => {
      return err instanceof AuthError && err.type === 'NotAuthorizedException' && /Incorrect username/.test(err.message);
    });
    let saved;
    const auth = new WhiskerAuth({ endpoint: fake.cognito, onTokens: (t) => (saved = t) });
    const tokens = await auth.login(TEST_EMAIL, TEST_PASSWORD);
    assert.equal(tokens.refreshToken, 'refresh-1');
    assert.ok(tokens.expiresAt > Date.now());
    assert.deepEqual(saved, tokens);
    assert.equal(await auth.userId(), '1234567');
  });

  it('refreshes from a saved token without the password', async () => {
    const c = client({ tokens: { refreshToken: 'refresh-1' } });
    assert.equal((await c.robots()).length, 2);
    assert.equal(fake.refreshes, 1);
    assert.equal(fake.logins, 0);
  });

  it('falls back to the password when the refresh token has expired', async () => {
    await assert.rejects(client({ tokens: { refreshToken: 'stale' } }).robots(), AuthError);
    const c = client({ tokens: { refreshToken: 'stale' }, email: TEST_EMAIL, password: TEST_PASSWORD });
    assert.equal((await c.robots()).length, 2);
    assert.equal(fake.logins, 1);
  });

  it('shares one refresh between concurrent requests', async () => {
    const c = client({ tokens: { refreshToken: 'refresh-1' } });
    await Promise.all([c.robots(), c.robots(), c.robots()]);
    assert.equal(fake.refreshes, 1);
  });

  it('reads the user ID from string and numeric mid claims', () => {
    assert.equal(userIdFromToken(fakeJwt({ mid: 'abc' })), 'abc');
    assert.equal(userIdFromToken(fakeJwt({ mid: 12345678901 })), '12345678901');
    assert.throws(() => userIdFromToken('nope'));
  });
});

describe('WhiskerClient', () => {
  it('lists robots and skips entries without a serial', async () => {
    fake.robots.push({ name: 'ghost', serial: '' });
    try {
      const robots = await client({ email: TEST_EMAIL, password: TEST_PASSWORD }).robots();
      assert.deepEqual(
        robots.map((r) => r.serial),
        ['LR4C000001', 'LR4C000002'],
      );
    } finally {
      fake.robots.pop();
    }
  });

  it('retries once with a fresh token after HTTP 401', async () => {
    const c = client({ email: TEST_EMAIL, password: TEST_PASSWORD });
    await c.robots();
    fake.expireNext = true;
    await c.robot('LR4C000001');
    assert.equal(fake.logins, 1, 'the refresh token is used, not the password');
    assert.equal(fake.refreshes, 1);
  });

  it('reports GraphQL errors and missing robots', async () => {
    const c = client({ email: TEST_EMAIL, password: TEST_PASSWORD });
    await assert.rejects(c.query('query broken { x }'), GraphQLError);
    await assert.rejects(c.robot('missing'), /no Litter-Robot 4 with serial missing/);
    await assert.rejects(c.sendCommand('LR4C000001', 'bogus'), /Error sending command/);
  });

  it('sends commands with JSON values and the command source', async () => {
    const robot = client({ email: TEST_EMAIL, password: TEST_PASSWORD }).robotHandle('LR4C000001', { confirmTimeoutMs: 0 });
    await robot.clean();
    await robot.setCleanCycleDelay(15);
    await robot.setNightLightBrightness('medium');
    await robot.setPanelBrightness('high');
    await robot.setPanelLock(true);
    await robot.setNightLightMode('auto');
    await robot.setPower(false);
    await robot.reset();
    assert.throws(() => robot.setCleanCycleDelay(4), RangeError);
    assert.deepEqual(
      fake.commands.map((c) => [c.command, c.value ?? null]),
      [
        ['cleanCycle', null],
        ['setClumpTime', '{"clumpTime":15}'],
        ['setNightLightValue', '{"nightLightPower":50}'],
        ['panelBrightnessHigh', null],
        ['keyPadLockOutOn', null],
        ['nightLightModeAuto', null],
        ['powerOff', null],
        ['shortResetPress', null],
      ],
    );
    assert.ok(fake.commands.every((c) => c.serial === 'LR4C000001' && c.commandSource === COMMAND_SOURCE));
  });

  it('waits for the robot to report a change, asking it to report in', async () => {
    const robot = client({ email: TEST_EMAIL, password: TEST_PASSWORD }).robotHandle('LR4C000001', { pollIntervalMs: 1 });
    fake.pending.set('LR4C000001', { nightLightMode: 'ON' });
    await robot.setNightLightMode('on');
    assert.deepEqual(
      fake.commands.map((c) => c.command),
      ['nightLightModeOn', 'requestState'],
    );
    assert.equal((await robot.getState()).nightLightMode, 'on');

    robot.confirmTimeoutMs = 20;
    await assert.rejects(robot.setPanelLock(true), NotConfirmedError);
    fake.robots[0]!.nightLightMode = 'OFF';
  });
});
