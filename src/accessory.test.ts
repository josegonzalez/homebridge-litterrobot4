import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as hap from '@homebridge/hap-nodejs';
import type { API, Logging, PlatformAccessory } from 'homebridge';

import { LitterRobotAccessory, type AccessoryContext } from './accessory.js';
import { HK } from './mapping.js';
import { parseRobot, Statuses, type Brightness, type NightLightMode, type Robot, type State } from './sdk/index.js';
import type { ServiceToggles } from './settings.js';
import { robotData } from './test/fake-whisker.js';

const { Service: S, Characteristic: C } = hap;

class FakePlatformAccessory extends hap.Accessory {
  context: Partial<AccessoryContext> = {};
}

/** An in-memory robot that records commands. */
class FakeRobot implements Robot {
  commands: string[] = [];
  fail = false;
  private async record(c: string): Promise<void> {
    if (this.fail) throw new Error('cloud unavailable');
    this.commands.push(c);
  }
  getState(): Promise<State> {
    return Promise.reject(new Error('not used'));
  }
  clean = () => this.record('clean');
  reset = () => this.record('reset');
  setPower = (on: boolean) => this.record(`power ${on}`);
  setPanelLock = (on: boolean) => this.record(`lock ${on}`);
  setNightLightMode = (m: NightLightMode) => this.record(`nightlight ${m}`);
  setNightLightBrightness = (b: Brightness) => this.record(`brightness ${b}`);
  setPanelBrightness = (b: Brightness) => this.record(`panel ${b}`);
  setCleanCycleDelay = (m: number) => this.record(`delay ${m}`);
}

const api = { hap } as unknown as API;
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

function harness(toggles: ServiceToggles = {}, state: State = parseRobot(robotData('LR4C000001', 'Upstairs'))) {
  const accessory = new FakePlatformAccessory('Upstairs', hap.uuid.generate(`test-${Math.random()}`));
  accessory.context = { kind: 'cloud', id: 'LR4C000001', name: 'Upstairs', toggles };
  const robot = new FakeRobot();
  let writes = 0;
  const handler = new LitterRobotAccessory(
    { api, log, afterWrite: () => writes++ },
    accessory as unknown as PlatformAccessory<AccessoryContext>,
    robot,
  );
  handler.update(state);
  return { accessory, robot, handler, writes: () => writes };
}

const svc = (a: FakePlatformAccessory, type: typeof hap.Service & { UUID: string }, subtype: string) => a.getServiceById(type as never, subtype)!;

describe('LitterRobotAccessory', () => {
  it('exposes every service with values from the robot', () => {
    const { accessory } = harness();
    assert.equal(svc(accessory, S.Switch, 'clean').getCharacteristic(C.On).value, false);
    assert.ok(svc(accessory, S.Switch, 'clean').isPrimaryService);

    const waste = svc(accessory, S.FilterMaintenance, 'waste');
    assert.equal(waste.getCharacteristic(C.FilterLifeLevel).value, 41);
    assert.equal(waste.getCharacteristic(C.FilterChangeIndication).value, HK.FilterChangeIndication.FILTER_OK);

    const litter = svc(accessory, S.FilterMaintenance, 'litter');
    assert.equal(litter.getCharacteristic(C.FilterLifeLevel).value, 68);
    assert.equal(litter.getCharacteristic(C.FilterChangeIndication).value, HK.FilterChangeIndication.CHANGE_FILTER, 'LOW litter asks for a refill');

    const cat = svc(accessory, S.OccupancySensor, 'cat');
    assert.equal(cat.getCharacteristic(C.OccupancyDetected).value, HK.OccupancyDetected.NOT_DETECTED);
    assert.equal(cat.getCharacteristic(C.StatusFault).value, HK.StatusFault.NO_FAULT);

    const light = svc(accessory, S.Lightbulb, 'nightlight');
    assert.equal(light.getCharacteristic(C.On).value, false);
    assert.equal(light.getCharacteristic(C.Brightness).value, 25);

    assert.equal(svc(accessory, S.Switch, 'panellock').getCharacteristic(C.On).value, false);
    assert.equal(svc(accessory, S.Switch, 'power').getCharacteristic(C.On).value, true);

    const info = accessory.getService(S.AccessoryInformation)!;
    assert.equal(info.getCharacteristic(C.Manufacturer).value, 'Whisker');
    assert.equal(info.getCharacteristic(C.Model).value, 'Litter-Robot 4');
    assert.equal(info.getCharacteristic(C.SerialNumber).value, 'LR4C000001');
    assert.equal(info.getCharacteristic(C.FirmwareRevision).value, '1.1.75');
  });

  it('answers HomeKit reads from the cache', async () => {
    const { accessory, robot } = harness();
    assert.equal(await svc(accessory, S.FilterMaintenance, 'waste').getCharacteristic(C.FilterLifeLevel).handleGetRequest(), 41);
    assert.deepEqual(robot.commands, []);
  });

  it('starts a clean cycle and shows it as on', async () => {
    const { accessory, robot, writes } = harness();
    const clean = svc(accessory, S.Switch, 'clean').getCharacteristic(C.On);
    await clean.handleSetRequest(true);
    assert.deepEqual(robot.commands, ['clean']);
    assert.equal(clean.value, true);
    assert.equal(writes(), 1);
    // Turning it off cannot stop a cycle and sends nothing.
    await clean.handleSetRequest(false);
    assert.deepEqual(robot.commands, ['clean']);
  });

  it('drives the night light, panel lock and power', async () => {
    const { accessory, robot } = harness();
    const light = svc(accessory, S.Lightbulb, 'nightlight');
    await light.getCharacteristic(C.On).handleSetRequest(true);
    await light.getCharacteristic(C.Brightness).handleSetRequest(60);
    await light.getCharacteristic(C.Brightness).handleSetRequest(55); // same level, nothing sent
    await svc(accessory, S.Switch, 'panellock').getCharacteristic(C.On).handleSetRequest(true);
    await svc(accessory, S.Switch, 'power').getCharacteristic(C.On).handleSetRequest(true); // already on
    assert.deepEqual(robot.commands, ['nightlight on', 'brightness medium', 'lock true']);
  });

  it('reverts the cache and reports a failed write', async () => {
    const { accessory, robot } = harness();
    robot.fail = true;
    const lock = svc(accessory, S.Switch, 'panellock').getCharacteristic(C.On);
    await assert.rejects(lock.handleSetRequest(true));
    assert.equal(lock.value, false);
    assert.ok(messages.some((m) => m.startsWith('error: [Upstairs] could not change settings')));
  });

  it('shows the cat and the full drawer', () => {
    const { accessory, handler } = harness();
    handler.update(parseRobot(robotData('LR4C000001', 'Upstairs', { robotStatus: 'ROBOT_CAT_DETECT', isDFIFull: true, DFILevelPercent: 100 })));
    assert.equal(svc(accessory, S.OccupancySensor, 'cat').getCharacteristic(C.OccupancyDetected).value, HK.OccupancyDetected.DETECTED);
    const waste = svc(accessory, S.FilterMaintenance, 'waste');
    assert.equal(waste.getCharacteristic(C.FilterLifeLevel).value, 0);
    assert.equal(waste.getCharacteristic(C.FilterChangeIndication).value, HK.FilterChangeIndication.CHANGE_FILTER);
  });

  it('shows a cleaning robot and faults', () => {
    const { accessory, handler } = harness();
    handler.update(parseRobot(robotData('LR4C000001', 'Upstairs', { robotStatus: 'ROBOT_CLEAN' })));
    assert.equal(svc(accessory, S.Switch, 'clean').getCharacteristic(C.On).value, true);
    handler.update(parseRobot(robotData('LR4C000001', 'Upstairs', { displayCode: 'DC_MTR_FAULT_PINCH' })));
    assert.equal(svc(accessory, S.OccupancySensor, 'cat').getCharacteristic(C.StatusFault).value, HK.StatusFault.GENERAL_FAULT);
  });

  it('reports No Response after repeated failures, or when the robot is offline, and recovers', async () => {
    const { accessory, handler } = harness();
    const power = svc(accessory, S.Switch, 'power').getCharacteristic(C.On);
    handler.fail(new Error('timeout'));
    assert.equal(await power.handleGetRequest(), true, 'one failure still serves the cache');
    handler.fail(new Error('timeout'));
    await assert.rejects(power.handleGetRequest(), (err: unknown) => err === hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    assert.ok(messages.some((m) => m.startsWith('warn: [Upstairs] not responding')));
    handler.update(parseRobot(robotData('LR4C000001', 'Upstairs')));
    assert.equal(await power.handleGetRequest(), true);

    handler.update({ ...parseRobot(robotData('LR4C000001', 'Upstairs')), online: false, status: Statuses.Offline });
    await assert.rejects(power.handleGetRequest(), (err: unknown) => err === hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  });

  it('keeps updating without duplicating services, and reuses restored services', () => {
    const first = harness();
    const count = first.accessory.services.length;
    first.handler.update(parseRobot(robotData('LR4C000001', 'Upstairs', { DFILevelPercent: 70 })));
    assert.equal(first.accessory.services.length, count);

    // A restart: a new handler on the cached accessory object.
    const again = new LitterRobotAccessory(
      { api, log, afterWrite: () => {} },
      first.accessory as unknown as PlatformAccessory<AccessoryContext>,
      new FakeRobot(),
    );
    again.update(parseRobot(robotData('LR4C000001', 'Upstairs')));
    assert.equal(first.accessory.services.length, count);
    assert.ok(messages.every((m) => !m.includes('same UUID')));
  });

  it('leaves out services that are turned off or not reported', () => {
    const { accessory } = harness({ nightLight: false, powerSwitch: false }, { status: Statuses.Ready, online: true, wasteLevel: 10 });
    assert.equal(accessory.getServiceById(S.Lightbulb as never, 'nightlight'), undefined);
    assert.equal(accessory.getServiceById(S.Switch as never, 'power'), undefined);
    assert.equal(accessory.getServiceById(S.FilterMaintenance as never, 'litter'), undefined, 'no litter level reported');
    assert.ok(accessory.getServiceById(S.FilterMaintenance as never, 'waste'));
    assert.ok(accessory.getServiceById(S.Switch as never, 'clean'));
  });
});
