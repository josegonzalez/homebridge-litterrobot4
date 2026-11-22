import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as map from './mapping.js';
import { Statuses, type State } from './sdk/index.js';

const state = (extra: Partial<State> = {}): State => ({ status: Statuses.Ready, online: true, ...extra });

describe('mapping', () => {
  it('maps the waste drawer to filter life', () => {
    assert.equal(map.wasteLife(state({ wasteLevel: 59 })), 41);
    assert.equal(map.wasteLife(state({ wasteLevel: 120 })), 0);
    assert.equal(map.wasteChange(state({ wasteLevel: 59 })), map.HK.FilterChangeIndication.FILTER_OK);
    assert.equal(map.wasteChange(state({ drawerFull: true })), map.HK.FilterChangeIndication.CHANGE_FILTER);
    assert.equal(map.wasteChange(state({ status: Statuses.DrawerFull2 })), map.HK.FilterChangeIndication.CHANGE_FILTER);
  });

  it('asks for litter when the app rates it low or empty', () => {
    for (const [s, change] of [
      ['OPTIMAL', 0],
      ['OVERFILL', 0],
      ['REFILL', 0],
      ['LOW', 1],
      ['EMPTY', 1],
    ] as const) {
      assert.equal(map.litterChange(state({ litterLevelState: s })), change, s);
    }
  });

  it('treats cleaning, emptying and pauses as cycling', () => {
    assert.equal(map.cycling(state({ status: Statuses.CleanCycle })), true);
    assert.equal(map.cycling(state({ status: Statuses.EmptyCycle })), true);
    assert.equal(map.cycling(state({ status: Statuses.Paused })), true);
    assert.equal(map.cycling(state()), false);
    assert.equal(map.cycling(state({ status: Statuses.CatDetected })), false);
  });

  it('snaps brightness to the three levels', () => {
    assert.deepEqual(
      [1, 25, 37, 38, 50, 75, 76, 100].map(map.brightnessLevel),
      ['low', 'low', 'low', 'medium', 'medium', 'medium', 'high', 'high'],
    );
    assert.equal(map.nightLightBrightness(state({ nightLightBrightness: 'medium' })), 50);
  });

  it('treats auto as on for the night light', () => {
    assert.equal(map.nightLightOn(state({ nightLightMode: 'auto' })), true);
    assert.equal(map.nightLightOn(state({ nightLightMode: 'off' })), false);
  });

  it('extracts a HomeKit firmware revision', () => {
    assert.equal(map.firmwareRevision('ESP 1.1.75, PIC 10500.3072.2.93'), '1.1.75');
    assert.equal(map.firmwareRevision(undefined), undefined);
  });
});
