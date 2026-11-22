import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { FakeESPHome } from '../../test/fake-esphome.js';
import { Statuses } from '../types.js';
import { ESPHomeRobot, objectId, UnauthorizedError } from './client.js';
import { parseChallenge } from './digest.js';

let fake: FakeESPHome;
before(async () => (fake = await new FakeESPHome().start()));
after(() => fake.stop());
beforeEach(() => (fake.posts = []));

const robot = (password = 's3cret') => new ESPHomeRobot({ host: fake.host, username: 'user', password });

describe('ESPHomeRobot', () => {
  it('reads the state through digest auth, with the object id fallback', async () => {
    const s = await robot().getState();
    assert.equal(s.power, true);
    assert.equal(s.panelLock, false);
    assert.equal(s.wasteLevel, 42);
    assert.equal(s.litterLevel, 88);
    assert.equal(s.catWeight, 10.2);
    assert.equal(s.cleanCycleDelay, 7);
    assert.equal(s.cleanCycles, 321);
    assert.equal(s.catDetected, false);
    assert.equal(s.nightLightMode, 'auto');
    assert.equal(s.nightLightBrightness, 'medium');
    assert.equal(s.panelBrightness, 'high');
    assert.equal(s.powerType, 'AC');
    assert.equal(s.fault, undefined);
    assert.equal(s.status, Statuses.Ready);
  });

  it('sends commands, matching select options from the device', async () => {
    const r = robot();
    await r.clean();
    await r.setPower(false);
    await r.setPanelLock(true);
    await r.setNightLightMode('off');
    await r.setNightLightBrightness('medium');
    await r.setPanelBrightness('medium');
    await r.setCleanCycleDelay(15);
    await r.reset();
    assert.deepEqual(fake.posts, [
      'button/Manual Cycle/press',
      'switch/Power/turn_off',
      'switch/Control Panel Lockout/turn_on',
      'select/Night Light Mode/set?option=Off',
      'select/Night Light Brightness/set?option=Med',
      'select/Panel Brightness/set?option=Medium',
      'number/Clean Cycle Delay/set?value=15',
      'button/Reset/press',
    ]);
  });

  it('reports a wrong password', async () => {
    await assert.rejects(robot('wrong').ping(), UnauthorizedError);
  });

  it('builds object ids like ESPHome', () => {
    assert.equal(objectId('Manual Cycle'), 'manual_cycle');
    assert.equal(objectId('WasteSense (IAQ)'), 'wastesense_iaq');
  });

  it('parses quoted challenge values with commas', () => {
    assert.deepEqual(parseChallenge(' realm="a, b", nonce="n", qop="auth,auth-int", algorithm=MD5, opaque="o"'), {
      realm: 'a, b',
      nonce: 'n',
      qop: 'auth,auth-int',
      algorithm: 'MD5',
      opaque: 'o',
    });
  });

  it('approximates the status from the entities', () => {
    const base = { status: Statuses.Unknown, online: true };
    assert.equal(ESPHomeRobot.status({ ...base, power: false }), Statuses.Off);
    assert.deepEqual(ESPHomeRobot.status({ ...base, fault: 'Pinch' }), { code: 'FAULT', text: 'Pinch' });
    assert.equal(ESPHomeRobot.status({ ...base, drawerFull: true }), Statuses.DrawerFull);
    assert.equal(ESPHomeRobot.status({ ...base, catDetected: true }), Statuses.CatDetected);
  });
});
