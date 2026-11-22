import type { API, Characteristic, CharacteristicValue, Logging, PlatformAccessory, Service, WithUUID } from 'homebridge';

import * as map from './mapping.js';
import { Statuses, type Robot, type State } from './sdk/index.js';
import type { ServiceToggles } from './settings.js';

/** What the accessory needs from the platform. */
export interface AccessoryDeps {
  api: API;
  log: Logging;
  /** Called after a successful write, so the platform can refresh the state soon. */
  afterWrite: () => void;
}

export interface AccessoryContext {
  kind: 'cloud' | 'esphome';
  /** Serial for cloud robots, MAC address or host for ESPHome robots. */
  id: string;
  name: string;
  toggles: ServiceToggles;
  host?: string;
  mac?: string;
  firmware?: string;
}

type ServiceType = WithUUID<new (displayName?: string, subtype?: string) => Service>;
type CharacteristicType = WithUUID<new () => Characteristic>;
type Getter = (state: State) => CharacteristicValue;
/** A write: an optimistic change to the cached state, and the command that makes it. */
type Setter = (value: CharacteristicValue, state: State) => { patch: Partial<State>; run: () => Promise<void> } | undefined;

interface Binding {
  key: string;
  service: Service;
  characteristic: CharacteristicType;
  get: Getter;
}

/** Consecutive failed polls before the robot is reported as not responding. */
export const OFFLINE_AFTER = 2;

/** One Litter-Robot 4 exposed to HomeKit. */
export class LitterRobotAccessory {
  private state?: State;
  private failures = 0;
  private queue: Promise<void> = Promise.resolve();
  private readonly bindings = new Map<string, Binding>();
  private readonly pushed = new Map<string, CharacteristicValue>();
  private readonly hap: API['hap'];

  constructor(
    private readonly deps: AccessoryDeps,
    readonly accessory: PlatformAccessory<AccessoryContext>,
    readonly robot: Robot,
  ) {
    this.hap = deps.api.hap;
    this.updateInformation();
  }

  get name(): string {
    return this.accessory.displayName;
  }

  /** The cached state, if any. */
  get current(): State | undefined {
    return this.state;
  }

  private prefix(message: string): string {
    return `[${this.name}] ${message}`;
  }

  /** Applies a fresh state from a poll. */
  update(state: State): void {
    if (this.failures >= OFFLINE_AFTER) {
      this.deps.log.info(this.prefix('responding again'));
    }
    this.failures = 0;
    if (!state.online && this.state?.online !== false) {
      this.deps.log.warn(this.prefix('the Whisker cloud reports the robot as offline'));
    }
    this.state = state;
    const firmware = map.firmwareRevision(state.firmware);
    if (firmware && firmware !== this.accessory.context.firmware) {
      this.accessory.context.firmware = firmware;
      this.updateInformation();
    }
    this.syncServices(state);
    this.push();
  }

  /** Records a failed poll. */
  fail(err: unknown): void {
    this.failures++;
    const message = err instanceof Error ? err.message : String(err);
    if (this.failures === OFFLINE_AFTER) {
      this.deps.log.warn(this.prefix(`not responding: ${message}`));
    } else {
      this.deps.log.debug(this.prefix(`poll failed: ${message}`));
    }
  }

  /** Whether HomeKit should show the robot as not responding. */
  get unavailable(): boolean {
    return !this.state || this.failures >= OFFLINE_AFTER || !this.state.online;
  }

  private updateInformation(): void {
    const { Service: S, Characteristic: C } = this.hap;
    const ctx = this.accessory.context;
    const info = this.accessory.getService(S.AccessoryInformation) ?? this.accessory.addService(S.AccessoryInformation);
    info.setCharacteristic(C.Manufacturer, 'Whisker');
    info.setCharacteristic(C.Model, ctx.kind === 'esphome' ? 'Litter-Robot 4 (ESPHome)' : 'Litter-Robot 4');
    info.setCharacteristic(C.SerialNumber, ctx.kind === 'cloud' ? ctx.id : (ctx.mac ?? ctx.host ?? ctx.id));
    if (ctx.firmware) {
      info.setCharacteristic(C.FirmwareRevision, ctx.firmware);
    }
  }

  /** Adds or removes services to match what the robot reports and the configuration allows. */
  private syncServices(state: State): void {
    const { Service: S, Characteristic: C } = this.hap;
    const t = this.accessory.context.toggles;
    const name = this.name;
    const on = (k: keyof ServiceToggles) => t[k] !== false;

    this.toggle(on('cleanSwitch'), S.Switch, `${name} Clean`, 'clean', (svc) => {
      svc.setPrimaryService(true);
      this.bind(svc, C.On, map.cycling, (v) => {
        if (!v) {
          // A cycle cannot be stopped; snap the switch back to the real state.
          setTimeout(() => this.pushNow(svc, C.On), 500).unref();
          return undefined;
        }
        return { patch: { status: Statuses.CleanCycle }, run: () => this.robot.clean() };
      });
    });

    this.toggle(on('wasteDrawer') && state.wasteLevel !== undefined, S.FilterMaintenance, `${name} Waste Drawer`, 'waste', (svc) => {
      this.bind(svc, C.FilterLifeLevel, map.wasteLife);
      this.bind(svc, C.FilterChangeIndication, map.wasteChange);
    });

    this.toggle(on('litterLevel') && state.litterLevel !== undefined, S.FilterMaintenance, `${name} Litter`, 'litter', (svc) => {
      this.bind(svc, C.FilterLifeLevel, map.litterLife);
      this.bind(svc, C.FilterChangeIndication, map.litterChange);
    });

    this.toggle(on('catSensor') && state.catDetected !== undefined, S.OccupancySensor, `${name} Cat`, 'cat', (svc) => {
      this.bind(svc, C.OccupancyDetected, map.occupancy);
      this.bind(svc, C.StatusFault, map.statusFault);
    });

    this.toggle(on('nightLight') && state.nightLightMode !== undefined, S.Lightbulb, `${name} Night Light`, 'nightlight', (svc) => {
      this.bind(svc, C.On, map.nightLightOn, (v, s) => {
        const mode = v ? 'on' : 'off';
        if (map.nightLightOn(s) === Boolean(v)) return undefined;
        return { patch: { nightLightMode: mode }, run: () => this.robot.setNightLightMode(mode) };
      });
      if (state.nightLightBrightness !== undefined) {
        this.bind(svc, C.Brightness, map.nightLightBrightness, (v, s) => {
          const level = map.brightnessLevel(Number(v));
          setTimeout(() => this.pushNow(svc, C.Brightness), 500).unref();
          if (level === s.nightLightBrightness) return undefined;
          return { patch: { nightLightBrightness: level }, run: () => this.robot.setNightLightBrightness(level) };
        });
      }
    });

    this.toggle(on('panelLockSwitch') && state.panelLock !== undefined, S.Switch, `${name} Panel Lock`, 'panellock', (svc) => {
      this.bind(svc, C.On, (s) => Boolean(s.panelLock), (v, s) => {
        if (Boolean(v) === s.panelLock) return undefined;
        return { patch: { panelLock: Boolean(v) }, run: () => this.robot.setPanelLock(Boolean(v)) };
      });
    });

    this.toggle(on('powerSwitch') && state.power !== undefined, S.Switch, `${name} Power`, 'power', (svc) => {
      this.bind(svc, C.On, (s) => Boolean(s.power), (v, s) => {
        if (Boolean(v) === s.power) return undefined;
        return { patch: { power: Boolean(v) }, run: () => this.robot.setPower(Boolean(v)) };
      });
    });
  }

  private toggle(want: boolean, type: ServiceType, name: string, subtype: string, setup: (svc: Service) => void): void {
    const existing = this.findService(type, subtype);
    if (!want) {
      if (existing) {
        for (const [key, b] of [...this.bindings]) {
          if (b.service === existing) {
            this.bindings.delete(key);
            this.pushed.delete(key);
          }
        }
        this.accessory.removeService(existing);
      }
      return;
    }
    setup(existing ?? this.ensureService(type, name, subtype));
  }

  private findService(type: ServiceType, subtype: string): Service | undefined {
    return this.accessory.services.find((s) => s.UUID === type.UUID && s.subtype === subtype);
  }

  private ensureService(type: ServiceType, name: string, subtype: string): Service {
    const { Characteristic: C } = this.hap;
    let svc = this.findService(type, subtype);
    if (!svc) {
      svc = this.accessory.addService(new type(name, subtype));
      svc.addOptionalCharacteristic(C.ConfiguredName);
      svc.setCharacteristic(C.ConfiguredName, name);
    }
    return svc;
  }

  private bindingKey(service: Service, characteristic: CharacteristicType): string {
    return `${service.UUID}/${service.subtype ?? ''}/${characteristic.UUID}`;
  }

  private bind(service: Service, characteristic: CharacteristicType, get: Getter, set?: Setter): void {
    const key = this.bindingKey(service, characteristic);
    if (this.bindings.has(key)) {
      return;
    }
    const c = service.getCharacteristic(characteristic);
    c.onGet(() => this.read(get));
    if (set) {
      c.onSet((value) => this.write(value, set));
    }
    this.bindings.set(key, { key, service, characteristic, get });
  }

  private read(get: Getter): CharacteristicValue {
    if (this.unavailable) {
      throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return get(this.state!);
  }

  private async write(value: CharacteristicValue, set: Setter): Promise<void> {
    if (this.unavailable) {
      throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    const change = set(value, this.state!);
    if (!change) {
      return;
    }
    const previous = this.state!;
    this.state = { ...previous, ...change.patch };
    this.push();
    // Commands go out one at a time, in order.
    const run = this.queue.then(change.run);
    this.queue = run.catch(() => {});
    try {
      await run;
      this.deps.afterWrite();
    } catch (err) {
      this.deps.log.error(this.prefix(`could not change settings: ${err instanceof Error ? err.message : err}`));
      this.state = previous;
      this.push();
      throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private pushNow(service: Service, characteristic: CharacteristicType): void {
    const b = this.bindings.get(this.bindingKey(service, characteristic));
    if (b && this.state) {
      const value = b.get(this.state);
      this.pushed.set(b.key, value);
      service.updateCharacteristic(characteristic, value);
    }
  }

  /** Sends changed values to HomeKit. */
  private push(): void {
    if (!this.state) {
      return;
    }
    for (const b of this.bindings.values()) {
      const value = b.get(this.state);
      if (this.pushed.get(b.key) !== value) {
        this.pushed.set(b.key, value);
        b.service.updateCharacteristic(b.characteristic, value);
      }
    }
  }
}
