import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { describe, it } from 'node:test';

import { assemble, discover, isRobotName } from './discovery.js';
import { decodeMessage, encodeResponse, RecordType, type ResourceRecord } from './mdns.js';

const records = (instance: string, host: string, address: string, mac: string): ResourceRecord[] => [
  { name: '_esphomelib._tcp.local', ttl: 120, type: RecordType.PTR, target: `${instance}._esphomelib._tcp.local` },
  { name: `${instance}._esphomelib._tcp.local`, ttl: 120, type: RecordType.SRV, priority: 0, weight: 0, port: 6053, target: host },
  { name: `${instance}._esphomelib._tcp.local`, ttl: 120, type: RecordType.TXT, entries: [`mac=${mac}`, 'platform=ESP32'] },
  { name: host, ttl: 120, type: RecordType.A, address },
];

describe('ESPHome discovery', () => {
  it('assembles robots and leaves out other ESPHome devices', () => {
    const all = [
      ...records('litter-robot4-010203', 'litter-robot4-010203.local', '192.168.1.60', '7c9ebd010203'),
      ...records('kitchen-plug', 'kitchen-plug.local', '192.168.1.61', 'a4cf12aabbcc'),
    ];
    assert.deepEqual(
      assemble(all).map((r) => [r.name, r.address, r.mac]),
      [['litter-robot4-010203', '192.168.1.60', '7C9EBD010203']],
    );
    assert.equal(assemble(all, true).length, 2);
  });

  it('recognizes robot names', () => {
    assert.ok(isRobotName('litter-robot4-a1b2c3'));
    assert.ok(isRobotName('LitterRobot'));
    assert.ok(!isRobotName('rabbitair'));
  });

  it('finds a robot answering on a test socket', async () => {
    const responder = createSocket('udp4');
    await new Promise<void>((r) => responder.bind(0, '127.0.0.1', r));
    responder.on('message', (msg, rinfo) => {
      const q = decodeMessage(msg);
      if (q.questions.some((x) => x.name === '_esphomelib._tcp.local')) {
        responder.send(encodeResponse(records('litter-robot4-010203', 'lr.local', '10.0.0.5', '7c9ebd010203')), rinfo.port, rinfo.address);
      }
    });
    try {
      const found = await discover({ timeoutMs: 300, rounds: 1, target: { address: '127.0.0.1', port: responder.address().port } });
      assert.deepEqual(
        found.map((r) => r.address),
        ['10.0.0.5'],
      );
    } finally {
      responder.close();
    }
  });
});
