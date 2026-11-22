/** A fake ESPHome web server with digest auth for tests. */
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { parseChallenge } from '../sdk/esphome/digest.js';

const REALM = 'asyncesp';
const NONCE = 'abc123';
const md5 = (s: string) => createHash('md5').update(s).digest('hex');

export class FakeESPHome {
  username = 'user';
  password = 's3cret';
  posts: string[] = [];
  /** "domain/name" to entity JSON. "Litter Level" only answers by object id, to exercise the fallback. */
  entities: Record<string, Record<string, unknown>> = {
    'switch/Power': { id: 'switch-power', state: 'ON', value: true },
    'switch/Control Panel Lockout': { id: 'switch-control_panel_lockout', state: 'OFF', value: false },
    'sensor/Waste Drawer Level': { id: 'sensor-waste_drawer_level', state: '42.0 %', value: 42 },
    'sensor/litter_level': { id: 'sensor-litter_level', state: '88 %', value: 88 },
    'sensor/Last Cat Weight': { id: 'sensor-last_cat_weight', state: '10.2 lbs', value: 10.2 },
    'sensor/Clean Cycles': { id: 'sensor-clean_cycles', state: '321', value: 321 },
    'number/Clean Cycle Delay': { id: 'number-clean_cycle_delay', state: '7', value: '7' },
    'binary_sensor/Waste Drawer Full': { id: 'binary_sensor-waste_drawer_full', state: 'OFF', value: false },
    'binary_sensor/Weight Detected': { id: 'binary_sensor-weight_detected', state: 'OFF', value: false },
    'binary_sensor/Sleeping': { id: 'binary_sensor-sleeping', state: 'OFF', value: false },
    'text_sensor/Fault': { id: 'text_sensor-fault', state: 'None', value: 'None' },
    'text_sensor/Power Type': { id: 'text_sensor-power_type', state: 'AC', value: 'AC' },
    'select/Night Light Mode': { id: 'select-night_light_mode', state: 'Auto', value: 'Auto', option: ['Off', 'On', 'Auto'] },
    'select/Night Light Brightness': { id: 'select-night_light_brightness', state: 'Med', value: 'Med', option: ['Low', 'Med', 'High'] },
    'select/Panel Brightness': { id: 'select-panel_brightness', state: 'High', value: 'High', option: ['Low', 'Medium', 'High'] },
  };
  private server?: Server;

  get host(): string {
    return `127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  private authorized(method: string, header: string | undefined, uri: string): boolean {
    if (!this.password) return true;
    if (!header?.startsWith('Digest ')) return false;
    const p = parseChallenge(header.slice(7));
    const ha1 = md5(`${this.username}:${REALM}:${this.password}`);
    const ha2 = md5(`${method}:${p.uri}`);
    const want = md5(`${ha1}:${NONCE}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`);
    return p.username === this.username && p.response === want && p.uri === uri;
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      const uri = req.url ?? '/';
      if (!this.authorized(req.method ?? 'GET', req.headers.authorization, uri)) {
        res.writeHead(401, { 'WWW-Authenticate': `Digest realm="${REALM}", qop="auth", nonce="${NONCE}", opaque="xyz"` });
        return res.end();
      }
      const url = new URL(uri, 'http://x');
      const [domain, id, action] = url.pathname.slice(1).split('/').map(decodeURIComponent);
      const key = `${domain}/${id}`;
      if (req.method === 'POST') {
        this.posts.push(`${key}/${action}${url.search}`);
        res.writeHead(200);
        return res.end();
      }
      const entity = this.entities[key];
      if (!entity) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(entity));
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    return this;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}
