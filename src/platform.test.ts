import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';

import * as hap from '@homebridge/hap-nodejs';
import type { API, Logging, PlatformAccessory } from 'homebridge';

import type { AccessoryContext } from './accessory.js';
import { LitterRobotPlatform } from './platform.js';
import type { LitterRobotPlatformConfig } from './settings.js';
import { FakeESPHome } from './test/fake-esphome.js';
import { FakeWhisker, TEST_EMAIL, TEST_PASSWORD } from './test/fake-whisker.js';
import { TOKEN_FILE } from './tokens.js';

class FakePlatformAccessory extends hap.Accessory {
  context: Partial<AccessoryContext> = {};
}

class FakeAPI extends EventEmitter {
  hap = hap;
  platformAccessory = FakePlatformAccessory;
  registered: PlatformAccessory<AccessoryContext>[] = [];
  unregistered: PlatformAccessory<AccessoryContext>[] = [];
  readonly storage = mkdtempSync(join(tmpdir(), 'lr4-'));
  user = { storagePath: () => this.storage };
  registerPlatformAccessories(_p: string, _n: string, a: PlatformAccessory<AccessoryContext>[]) {
    this.registered.push(...a);
  }
  unregisterPlatformAccessories(_p: string, _n: string, a: PlatformAccessory<AccessoryContext>[]) {
    this.unregistered.push(...a);
  }
  updatePlatformAccessories() {}
}

const messages: string[] = [];
const log = Object.assign((m: string) => messages.push(m), {
  info: (m: string) => messages.push(`info: ${m}`),
  warn: (m: string) => messages.push(`warn: ${m}`),
  error: (m: string) => messages.push(`error: ${m}`),
  debug: () => {},
  success: (m: string) => messages.push(m),
  log: () => {},
  prefix: 'test',
}) as unknown as Logging;

let whisker: FakeWhisker;
let esphome: FakeESPHome;
before(async () => {
  whisker = await new FakeWhisker().start();
  esphome = await new FakeESPHome().start();
  LitterRobotPlatform.endpoints = { cognito: whisker.cognito, graphql: whisker.graphql };
});
after(async () => {
  LitterRobotPlatform.endpoints = {};
  await whisker.stop();
  await esphome.stop();
});

const platforms: LitterRobotPlatform[] = [];
afterEach(() => platforms.splice(0).forEach((p) => p.stop()));

async function launch(config: Partial<LitterRobotPlatformConfig>, api = new FakeAPI(), cached: PlatformAccessory[] = []) {
  const platform = new LitterRobotPlatform(log, { platform: 'LitterRobot4', ...config } as LitterRobotPlatformConfig, api as unknown as API);
  platforms.push(platform);
  for (const a of cached) platform.configureAccessory(a);
  api.emit('didFinishLaunching');
  // Let the launch and first polls finish.
  for (let i = 0; i < 50 && api.registered.length + api.unregistered.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  await new Promise((r) => setTimeout(r, 50));
  return api;
}

describe('LitterRobotPlatform', () => {
  it('adds every robot on the account and caches the session privately', async () => {
    const api = await launch({ email: TEST_EMAIL, password: TEST_PASSWORD });
    assert.deepEqual(
      api.registered.map((a) => [a.displayName, a.context.id]),
      [
        ['Upstairs', 'LR4C000001'],
        ['Basement', 'LR4C000002'],
      ],
    );
    const file = join(api.storage, TOKEN_FILE);
    if (process.platform !== 'win32') {
      assert.equal(statSync(file).mode & 0o777, 0o600);
    }
  });

  it('renames and hides robots from the configuration, and removes hidden cached ones', async () => {
    const first = await launch({ email: TEST_EMAIL, password: TEST_PASSWORD });
    platforms.splice(0).forEach((p) => p.stop());
    const api = await launch(
      {
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
        robots: [
          { serial: 'LR4C000001', name: 'Office Box' },
          { serial: 'LR4C000002', hidden: true },
          { serial: '' },
        ],
      },
      new FakeAPI(),
      first.registered,
    );
    assert.equal(first.registered[0]!.displayName, 'Upstairs', 'the HomeKit name stays until re-added');
    assert.equal(first.registered[0]!.context.name, 'Office Box');
    assert.deepEqual(
      api.unregistered.map((a) => a.context.id),
      ['LR4C000002'],
    );
  });

  it('reports bad credentials without crashing', async () => {
    const api = new FakeAPI();
    await launch({ email: TEST_EMAIL, password: 'nope' }, api);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(api.registered.length, 0);
    assert.ok(messages.some((m) => m.startsWith('warn: could not list robots on the Whisker account')));
  });

  it('adds ESPHome robots by host', async () => {
    const api = await launch({ esphome: [{ name: 'Garage', host: esphome.host, password: 's3cret' }, { name: '' }], discovery: false });
    assert.deepEqual(
      api.registered.map((a) => [a.displayName, a.context.kind]),
      [['Garage', 'esphome']],
    );
    await new Promise((r) => setTimeout(r, 200));
    const waste = api.registered[0]!.getServiceById(hap.Service.FilterMaintenance as never, 'waste');
    assert.equal(waste?.getCharacteristic(hap.Characteristic.FilterLifeLevel).value, 58);
  });
});
