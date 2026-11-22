/**
 * Litter-Robot 4 units flashed with the open source ESPHome firmware
 * (https://codeberg.org/Joseph-DiGiovanni/esphome-litter-robot), controlled
 * through the ESPHome web server REST API.
 */
import { BRIGHTNESS_LEVELS, NIGHT_LIGHT_MODES, Statuses, validateCleanCycleDelay, type Brightness, type NightLightMode, type Robot, type State } from '../types.js';
import { DigestAuth } from './digest.js';

/** The web server user in the firmware's example config. */
export const DEFAULT_USERNAME = 'user';

/** Entity names used by the firmware's litter-robot4 package. */
export const Entities = {
  ButtonCycle: 'Manual Cycle',
  ButtonReset: 'Reset',
  SwitchPower: 'Power',
  SwitchPanelLock: 'Control Panel Lockout',
  SelectNightLightMode: 'Night Light Mode',
  SelectNightLightBrightness: 'Night Light Brightness',
  SelectPanelBrightness: 'Panel Brightness',
  NumberCleanCycleDelay: 'Clean Cycle Delay',
  SensorWasteLevel: 'Waste Drawer Level',
  SensorLitterLevel: 'Litter Level',
  SensorCatWeight: 'Last Cat Weight',
  SensorCleanCycles: 'Clean Cycles',
  BinaryDrawerFull: 'Waste Drawer Full',
  BinarySleeping: 'Sleeping',
  BinaryWeightDetected: 'Weight Detected',
  TextFault: 'Fault',
  TextPowerType: 'Power Type',
  TextRobotStatus: 'Robot Status',
} as const;

/** An entity state from the web server. */
export interface Entity {
  id: string;
  state?: string;
  value?: unknown;
  option?: string[];
}

/** The device has no such entity. */
export class EntityNotFoundError extends Error {
  constructor(domain: string, name: string) {
    super(`${domain} "${name}" not found`);
    this.name = 'EntityNotFoundError';
  }
}

/** The device rejected the web server credentials. */
export class UnauthorizedError extends Error {
  constructor() {
    super('the robot rejected the web server username or password');
    this.name = 'UnauthorizedError';
  }
}

/** The ESPHome object id for an entity name. */
export function objectId(name: string): string {
  return name
    .toLowerCase()
    .replace(/ /g, '_')
    .replace(/[^a-z0-9_-]/g, '');
}

function entityNumber(e: Entity | undefined): number | undefined {
  if (!e) return undefined;
  if (typeof e.value === 'number') return e.value;
  const n = Number.parseFloat(typeof e.value === 'string' ? e.value : (e.state ?? ''));
  return Number.isNaN(n) ? undefined : n;
}

function entityBool(e: Entity | undefined): boolean | undefined {
  if (!e) return undefined;
  if (typeof e.value === 'boolean') return e.value;
  const s = e.state?.toUpperCase();
  return s === 'ON' ? true : s === 'OFF' ? false : undefined;
}

function entityText(e: Entity | undefined): string | undefined {
  if (!e) return undefined;
  return typeof e.value === 'string' ? e.value : e.state;
}

function parseBrightness(s: string | undefined): Brightness | undefined {
  const v = s?.trim().toLowerCase();
  return v === 'med' ? 'medium' : BRIGHTNESS_LEVELS.find((b) => b === v);
}

export interface ESPHomeOptions {
  /** IP address, hostname or URL, optionally with a port. */
  host: string;
  username?: string;
  password?: string;
  /** Per request timeout in milliseconds (default 10000). */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** A robot running ESPHome firmware. */
export class ESPHomeRobot implements Robot {
  private base: string;
  private readonly auth?: DigestAuth;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: ESPHomeOptions) {
    this.base = ESPHomeRobot.baseUrl(options.host);
    this.auth = options.password ? new DigestAuth(options.username ?? DEFAULT_USERNAME, options.password) : undefined;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchFn = options.fetch ?? fetch;
  }

  private static baseUrl(host: string): string {
    if (!host) {
      throw new Error('a host is required');
    }
    return (host.includes('://') ? host : `http://${host}`).replace(/\/+$/, '');
  }

  /** The device URL. */
  get url(): string {
    return this.base;
  }

  /** Points the client at a new address. */
  setHost(host: string): void {
    this.base = ESPHomeRobot.baseUrl(host);
  }

  private async request(method: string, path: string): Promise<Response> {
    const url = new URL(this.base + path);
    const uri = url.pathname + url.search;
    const send = () => {
      const headers: Record<string, string> = {};
      const auth = this.auth?.header(method, uri);
      if (auth) headers.Authorization = auth;
      return this.fetchFn(url, { method, headers, signal: AbortSignal.timeout(this.timeoutMs) });
    };
    let response = await send();
    if (response.status === 401 && this.auth && this.auth.accept(response.headers.get('www-authenticate'))) {
      await response.body?.cancel();
      response = await send();
    }
    if (response.status === 401) {
      await response.body?.cancel();
      throw new UnauthorizedError();
    }
    return response;
  }

  /** Requests an entity by name, then by object id, since the URL format changed between ESPHome versions. */
  private async entityRequest(method: string, domain: string, name: string, action = '', query = ''): Promise<Response> {
    for (const id of [name, objectId(name)]) {
      const path = `/${domain}/${encodeURIComponent(id)}${action ? `/${action}` : ''}${query}`;
      const response = await this.request(method, path);
      if (response.status === 404) {
        await response.body?.cancel();
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`ESPHome: ${method} ${path}: HTTP ${response.status}`);
      }
      return response;
    }
    throw new EntityNotFoundError(domain, name);
  }

  /** Reads an entity. */
  async get(domain: string, name: string): Promise<Entity> {
    const response = await this.entityRequest('GET', domain, name, '', '?detail=all');
    return (await response.json()) as Entity;
  }

  /** Invokes an action on an entity, such as press, turn_on or set. */
  async post(domain: string, name: string, action: string, params: Record<string, string> = {}): Promise<void> {
    const query = Object.keys(params).length ? `?${new URLSearchParams(params)}` : '';
    const response = await this.entityRequest('POST', domain, name, action, query);
    await response.body?.cancel();
  }

  private async tryGet(domain: string, name: string): Promise<Entity | undefined> {
    try {
      return await this.get(domain, name);
    } catch (err) {
      if (err instanceof EntityNotFoundError) return undefined;
      throw err;
    }
  }

  /** Checks that the device answers and accepts the credentials. */
  async ping(): Promise<void> {
    await this.get('switch', Entities.SwitchPower);
  }

  /** Reads the robot's entities. Entities the firmware does not expose are left unset. */
  async getState(): Promise<State> {
    const E = Entities;
    const [power, waste, litter, cat, cycles, delay, full, sleeping, lock, powerType, fault, mode, nlBright, panel, robotStatus, weight] =
      await Promise.all([
        this.tryGet('switch', E.SwitchPower),
        this.tryGet('sensor', E.SensorWasteLevel),
        this.tryGet('sensor', E.SensorLitterLevel),
        this.tryGet('sensor', E.SensorCatWeight),
        this.tryGet('sensor', E.SensorCleanCycles),
        this.tryGet('number', E.NumberCleanCycleDelay),
        this.tryGet('binary_sensor', E.BinaryDrawerFull),
        this.tryGet('binary_sensor', E.BinarySleeping),
        this.tryGet('switch', E.SwitchPanelLock),
        this.tryGet('text_sensor', E.TextPowerType),
        this.tryGet('text_sensor', E.TextFault),
        this.tryGet('select', E.SelectNightLightMode),
        this.tryGet('select', E.SelectNightLightBrightness),
        this.tryGet('select', E.SelectPanelBrightness),
        this.tryGet('text_sensor', E.TextRobotStatus),
        this.tryGet('binary_sensor', E.BinaryWeightDetected),
      ]);
    if (!power && !waste && !litter) {
      // Nothing answered by name: make sure the device itself is reachable.
      await this.ping();
    }
    const s: State = {
      status: Statuses.Unknown,
      online: true,
      power: entityBool(power),
      wasteLevel: entityNumber(waste),
      litterLevel: entityNumber(litter),
      catWeight: entityNumber(cat),
      cleanCycles: entityNumber(cycles),
      cleanCycleDelay: entityNumber(delay),
      drawerFull: entityBool(full),
      sleeping: entityBool(sleeping),
      panelLock: entityBool(lock),
      powerType: entityText(powerType),
      catDetected: entityBool(weight),
      nightLightBrightness: parseBrightness(entityText(nlBright)),
      panelBrightness: parseBrightness(entityText(panel)),
    };
    const m = entityText(mode)?.trim().toLowerCase();
    if (m && NIGHT_LIGHT_MODES.includes(m as NightLightMode)) {
      s.nightLightMode = m as NightLightMode;
    }
    const f = entityText(fault)?.trim();
    if (f && !['none', 'ok', ''].includes(f.toLowerCase())) {
      s.fault = f;
    }
    s.status = ESPHomeRobot.status(s, entityText(robotStatus));
    return s;
  }

  /** Approximates the Whisker status from the firmware's entities. */
  static status(s: State, robotStatus?: string): State['status'] {
    if (s.power === false) return Statuses.Off;
    if (s.fault) return { code: 'FAULT', text: s.fault };
    if (robotStatus) return { code: '', text: robotStatus };
    if (s.drawerFull) return Statuses.DrawerFull;
    if (s.catDetected) return Statuses.CatDetected;
    return Statuses.Ready;
  }

  clean(): Promise<void> {
    return this.post('button', Entities.ButtonCycle, 'press');
  }

  reset(): Promise<void> {
    return this.post('button', Entities.ButtonReset, 'press');
  }

  setPower(on: boolean): Promise<void> {
    return this.post('switch', Entities.SwitchPower, on ? 'turn_on' : 'turn_off');
  }

  setPanelLock(on: boolean): Promise<void> {
    return this.post('switch', Entities.SwitchPanelLock, on ? 'turn_on' : 'turn_off');
  }

  /** Picks the select option matching one of want, ignoring case, from the options the device reports. */
  private async setSelect(name: string, want: string[]): Promise<void> {
    const entity = await this.get('select', name);
    const options = entity.option ?? [];
    let option = options.find((o) => want.some((w) => w.toLowerCase() === o.toLowerCase()));
    if (!option) {
      if (options.length) {
        throw new RangeError(`"${name}" has no option ${want[0]} (options: ${options.join(', ')})`);
      }
      option = want[0]!.charAt(0).toUpperCase() + want[0]!.slice(1);
    }
    await this.post('select', name, 'set', { option });
  }

  setNightLightMode(mode: NightLightMode): Promise<void> {
    return this.setSelect(Entities.SelectNightLightMode, [mode]);
  }

  setNightLightBrightness(level: Brightness): Promise<void> {
    return this.setSelect(Entities.SelectNightLightBrightness, level === 'medium' ? ['medium', 'med'] : [level]);
  }

  setPanelBrightness(level: Brightness): Promise<void> {
    return this.setSelect(Entities.SelectPanelBrightness, level === 'medium' ? ['medium', 'med'] : [level]);
  }

  async setCleanCycleDelay(minutes: number): Promise<void> {
    validateCleanCycleDelay(minutes);
    await this.post('number', Entities.NumberCleanCycleDelay, 'set', { value: String(minutes) });
  }
}
