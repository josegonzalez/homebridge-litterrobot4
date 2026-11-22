import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isBlankCloudRobot, isBlankESPHomeRobot } from './settings.js';

describe('blank entries', () => {
  it('treats rows with only form defaults as blank', () => {
    assert.ok(isBlankCloudRobot({ hidden: false, cleanSwitch: true } as never));
    assert.ok(isBlankCloudRobot({ serial: '  ' }));
    assert.ok(isBlankCloudRobot(null));
    assert.ok(!isBlankCloudRobot({ serial: 'LR4C000001' }));
    assert.ok(isBlankESPHomeRobot({ username: 'user', nightLight: true } as never));
    assert.ok(!isBlankESPHomeRobot({ name: 'Garage' } as never));
    assert.ok(!isBlankESPHomeRobot({ host: '192.168.1.60' } as never));
  });
});
