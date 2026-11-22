import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { FakeESPHome } from '../test/fake-esphome.js';
import { FakeWhisker, TEST_EMAIL, TEST_PASSWORD } from '../test/fake-whisker.js';
import { accountRobots, verifyESPHome } from './routes.js';

let whisker: FakeWhisker;
let esphome: FakeESPHome;
before(async () => {
  whisker = await new FakeWhisker().start();
  esphome = await new FakeESPHome().start();
});
after(async () => {
  await whisker.stop();
  await esphome.stop();
});

const code = (expected: string) => (err: unknown) => (err as { requestError?: { code?: string } }).requestError?.code === expected;

describe('settings UI routes', () => {
  const endpoints = () => ({ cognitoEndpoint: whisker.cognito, graphqlEndpoint: whisker.graphql });

  it('lists the robots on an account', async () => {
    const robots = await accountRobots({ email: TEST_EMAIL, password: TEST_PASSWORD }, endpoints());
    assert.deepEqual(robots, [
      { serial: 'LR4C000001', name: 'Upstairs', status: 'Ready', online: true },
      { serial: 'LR4C000002', name: 'Basement', status: 'Ready', online: true },
    ]);
  });

  it('explains missing and wrong credentials', async () => {
    await assert.rejects(accountRobots({ email: TEST_EMAIL }, endpoints()), code('missing'));
    await assert.rejects(accountRobots({ email: TEST_EMAIL, password: 'nope' }, endpoints()), (err: unknown) => {
      return code('auth')(err) && (err as Error).message.startsWith('Incorrect email or password');
    });
  });

  it('checks ESPHome credentials', async () => {
    const ok = await verifyESPHome({ host: esphome.host, username: 'user', password: 's3cret' });
    assert.equal(ok.status, 'Ready');
    await assert.rejects(verifyESPHome({ host: esphome.host, username: 'user', password: 'wrong' }), code('rejected'));
    await assert.rejects(verifyESPHome({}), code('host'));
  });
});
