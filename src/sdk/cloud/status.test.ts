import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { robotData } from '../../test/fake-whisker.js';
import { Statuses } from '../types.js';
import { litterLevel, parseRobot, robotStatus } from './status.js';

describe('robotStatus', () => {
  const base = (extra: Record<string, unknown> = {}) => ({ isOnline: true, unitPowerStatus: 'ON', robotStatus: 'ROBOT_IDLE', ...extra });
  const cases: [string, Record<string, unknown>, (typeof Statuses)[keyof typeof Statuses]][] = [
    ['offline wins', base({ isOnline: false, displayCode: 'DC_MTR_FAULT_PINCH' }), Statuses.Offline],
    ['missing online', { unitPowerStatus: 'ON' }, Statuses.Offline],
    ['power off', base({ unitPowerStatus: 'OFF' }), Statuses.Off],
    ['fault display code', base({ displayCode: 'DC_MTR_FAULT_PINCH', robotCycleState: 'CYCLE_STATE_PAUSE' }), Statuses.PinchDetect],
    ['over torque', base({ displayCode: 'DC_MTR_FAULT_OT_SLP' }), Statuses.OverTorqueFault],
    ['cycle state beats robot status', base({ robotCycleState: 'CYCLE_STATE_PAUSE', robotStatus: 'ROBOT_CLEAN' }), Statuses.Paused],
    ['cleaning', base({ robotStatus: 'ROBOT_CLEAN' }), Statuses.CleanCycle],
    ['find dump is cleaning', base({ robotStatus: 'ROBOT_FIND_DUMP' }), Statuses.CleanCycle],
    ['ready', base(), Statuses.Ready],
    ['ready with cat', base({ displayCode: 'DC_CAT_DETECT', isDFIFull: true }), Statuses.CatDetected],
    ['ready with full drawer', base({ isDFIFull: true }), Statuses.DrawerFull],
    ['full drawer only matters when ready', base({ isDFIFull: true, robotStatus: 'ROBOT_CLEAN' }), Statuses.CleanCycle],
    ['unknown robot status', base({ robotStatus: 'ROBOT_SOMETHING_NEW' }), Statuses.Unknown],
  ];
  for (const [name, data, want] of cases) {
    it(name, () => assert.equal(robotStatus(data), want));
  }
});

describe('litterLevel', () => {
  it('prefers the percentage', () => assert.equal(litterLevel({ litterLevelPercentage: 0.68 }), 68));
  it('falls back to the distance like pylitterbot', () => {
    for (const [level, want] of [
      [440, 100],
      [470, 50],
      [500, 0],
      [600, 0],
      [452, 80],
    ] as const) {
      assert.equal(litterLevel({ litterLevel: level }), want, `level ${level}`);
    }
  });
  it('is undefined without data', () => assert.equal(litterLevel({}), undefined));
});

describe('parseRobot', () => {
  it('converts real robot data', () => {
    const s = parseRobot(robotData('LR4C000002', 'Basement Litter Robot'));
    assert.equal(s.status, Statuses.Ready);
    assert.equal(s.litterLevel, 68);
    assert.equal(s.litterLevelState, 'LOW');
    assert.equal(s.wasteLevel, 59);
    assert.equal(s.catWeight, 8.78);
    assert.equal(s.catDetected, false);
    assert.equal(s.nightLightMode, 'off');
    assert.equal(s.nightLightBrightness, 'low');
    assert.equal(s.panelBrightness, 'low');
    assert.equal(s.panelLock, false);
    assert.equal(s.cleanCycleDelay, 7);
    assert.equal(s.sleeping, false);
    assert.equal(s.power, true);
    assert.equal(s.firmware, 'ESP 1.1.75, PIC 10500.3072.2.93, laser 5.0.2.1');
    assert.equal(s.lastSeen?.toISOString(), '2026-11-06T03:45:36.867Z');
  });

  it('detects a cat from the status or the cat sensor', () => {
    assert.equal(parseRobot(robotData('A', 'a', { robotStatus: 'ROBOT_CAT_DETECT' })).catDetected, true);
    assert.equal(parseRobot(robotData('A', 'a', { catDetect: 'CAT_DETECT_LASER' })).catDetected, true);
  });
});
