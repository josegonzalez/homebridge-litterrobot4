import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Poller } from './poller.js';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Poller', () => {
  it('runs one task at a time and can run sooner', async () => {
    let runs = 0;
    let active = 0;
    let overlap = false;
    const poller = new Poller(async () => {
      active++;
      overlap ||= active > 1;
      runs++;
      await tick(5);
      active--;
    }, 60_000);
    await poller.start();
    assert.equal(runs, 1);
    await Promise.all([poller.run(), poller.run()]);
    assert.equal(runs, 2, 'concurrent calls share one run');
    poller.soon(1, 2);
    await tick(40);
    assert.ok(runs >= 3);
    assert.equal(overlap, false);
    poller.stop();
    const before = runs;
    await poller.run();
    assert.equal(runs, before, 'stopped pollers do nothing');
  });

  it('keeps going after a failing task', async () => {
    let runs = 0;
    const errors: unknown[] = [];
    const poller = new Poller(
      async () => {
        runs++;
        throw new Error('boom');
      },
      5,
      (err) => errors.push(err),
    );
    await poller.start();
    await tick(40);
    poller.stop();
    assert.ok(runs >= 2);
    assert.equal(errors.length, runs);
  });
});
