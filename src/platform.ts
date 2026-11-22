import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory } from 'homebridge';

import { LitterRobotAccessory, type AccessoryContext } from './accessory.js';
import { Poller } from './poller.js';
import {
  CloudRobot,
  discover,
  ESPHomeRobot,
  findRobot,
  normalizeMac,
  parseRobot,
  WhiskerAuth,
  WhiskerClient,
  type DiscoveredRobot,
  type RobotData,
} from './sdk/index.js';
import {
  DEFAULT_POLL_INTERVAL,
  isBlankCloudRobot,
  isBlankESPHomeRobot,
  MIN_POLL_INTERVAL,
  PLATFORM_NAME,
  PLUGIN_NAME,
  SERVICE_TOGGLES,
  type CloudRobotConfig,
  type ESPHomeRobotConfig,
  type LitterRobotPlatformConfig,
  type ServiceToggles,
} from './settings.js';
import { TokenCache } from './tokens.js';

/** Re-reads after a write: the robot needs a few seconds to report the change to the cloud. */
const REFRESH_AFTER_WRITE_MS = [4000, 12000];

const toggles = (c: ServiceToggles): ServiceToggles => Object.fromEntries(SERVICE_TOGGLES.filter((k) => c[k] !== undefined).map((k) => [k, c[k]]));

export class LitterRobotPlatform implements DynamicPlatformPlugin {
  /** Overrides the Whisker endpoints, for tests. */
  static endpoints: { cognito?: string; graphql?: string } = {};

  private readonly cached = new Map<string, PlatformAccessory<AccessoryContext>>();
  private readonly cloudRobots = new Map<string, LitterRobotAccessory>();
  private readonly pollers: Poller[] = [];
  private readonly config: LitterRobotPlatformConfig;
  private readonly pollIntervalMs: number;
  private cloud?: WhiskerClient;
  private cloudPoller?: Poller;
  private cloudSynced = false;

  constructor(
    private readonly log: Logging,
    config: LitterRobotPlatformConfig,
    private readonly api: API,
  ) {
    this.config = config;
    this.pollIntervalMs = 1000 * Math.max(MIN_POLL_INTERVAL, config.pollInterval ?? DEFAULT_POLL_INTERVAL);
    api.on('didFinishLaunching', () => {
      this.launch().catch((err) => this.log.error(`setup failed: ${err instanceof Error ? err.stack : err}`));
    });
    api.on('shutdown', () => this.stop());
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cached.set(accessory.UUID, accessory as PlatformAccessory<AccessoryContext>);
  }

  stop(): void {
    for (const p of this.pollers) {
      p.stop();
    }
  }

  private async launch(): Promise<void> {
    const keep = new Set<string>();
    await this.launchESPHome(keep);
    this.launchCloud(keep);

    // Cloud accessories are kept until the first successful poll, which
    // removes the ones no longer on the account.
    const stale = [...this.cached.values()].filter((a) => !keep.has(a.UUID) && a.context?.kind !== 'cloud');
    if (!this.cloud) {
      stale.push(...[...this.cached.values()].filter((a) => a.context?.kind === 'cloud'));
    }
    this.unregister(stale);
  }

  private unregister(accessories: PlatformAccessory[]): void {
    if (accessories.length === 0) {
      return;
    }
    this.log.info(`removing ${accessories.length} accessory(ies) no longer in the configuration`);
    for (const a of accessories) {
      this.cached.delete(a.UUID);
    }
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, accessories);
  }

  // Cloud robots ------------------------------------------------------------

  private cloudConfig(): Map<string, CloudRobotConfig> {
    const out = new Map<string, CloudRobotConfig>();
    for (const r of this.config.robots ?? []) {
      if (!isBlankCloudRobot(r) && r.serial) {
        out.set(r.serial.trim().toUpperCase(), r);
      }
    }
    return out;
  }

  private launchCloud(keep: Set<string>): void {
    const { email, password } = this.config;
    if (!email || !password) {
      if (email || password || (this.config.robots ?? []).some((r) => !isBlankCloudRobot(r))) {
        this.log.error('set both "email" and "password" for your Whisker account to add robots with stock firmware');
      }
      return;
    }
    const cache = new TokenCache(this.api.user.storagePath());
    const auth = new WhiskerAuth({
      email,
      password,
      tokens: cache.load(email),
      endpoint: LitterRobotPlatform.endpoints.cognito,
      onTokens: (tokens) => {
        try {
          cache.save(email, tokens);
        } catch (err) {
          this.log.debug(`could not cache Whisker tokens: ${err instanceof Error ? err.message : err}`);
        }
      },
    });
    this.cloud = new WhiskerClient({ auth, endpoint: LitterRobotPlatform.endpoints.graphql });

    // Restore cached accessories right away, so HomeKit keeps them while the cloud is unreachable.
    const configs = this.cloudConfig();
    for (const accessory of this.cached.values()) {
      const ctx = accessory.context;
      if (ctx?.kind === 'cloud' && !configs.get(ctx.id)?.hidden) {
        keep.add(accessory.UUID);
        this.addCloudRobot(ctx.id, undefined, configs.get(ctx.id));
      }
    }

    this.cloudPoller = new Poller(
      () => this.pollCloud(),
      this.pollIntervalMs,
      (err) => this.log.error(`cloud poll failed: ${err instanceof Error ? err.stack : err}`),
    );
    this.pollers.push(this.cloudPoller);
    void this.cloudPoller.start();
  }

  private async pollCloud(): Promise<void> {
    let robots: RobotData[];
    try {
      robots = await this.cloud!.robots();
    } catch (err) {
      if (this.cloudRobots.size === 0) {
        this.log.warn(`could not list robots on the Whisker account: ${err instanceof Error ? err.message : err}`);
      }
      for (const a of this.cloudRobots.values()) {
        a.fail(err);
      }
      return;
    }

    const configs = this.cloudConfig();
    const seen = new Set<string>();
    for (const data of robots) {
      const serial = String(data.serial).toUpperCase();
      seen.add(serial);
      if (configs.get(serial)?.hidden) {
        continue;
      }
      const accessory = this.cloudRobots.get(serial) ?? this.addCloudRobot(serial, data, configs.get(serial));
      accessory.update(parseRobot(data));
    }

    if (!this.cloudSynced) {
      this.cloudSynced = true;
      for (const serial of configs.keys()) {
        if (!seen.has(serial)) {
          this.log.warn(`robot ${serial} is in the configuration but not on the Whisker account`);
        }
      }
      const stale = [...this.cloudRobots.entries()].filter(([serial]) => !seen.has(serial) || configs.get(serial)?.hidden);
      for (const [serial] of stale) {
        this.cloudRobots.delete(serial);
      }
      const hidden = [...this.cached.values()].filter((a) => a.context?.kind === 'cloud' && configs.get(a.context.id)?.hidden);
      this.unregister([...new Set([...stale.map(([, a]) => a.accessory), ...hidden])]);
    }
  }

  private addCloudRobot(serial: string, data: RobotData | undefined, config: CloudRobotConfig | undefined): LitterRobotAccessory {
    const uuid = this.api.hap.uuid.generate(`litterrobot4:cloud:${serial}`);
    let accessory = this.cached.get(uuid);
    const appName = typeof data?.name === 'string' && data.name ? data.name : undefined;
    const name = config?.name?.trim() || accessory?.context.name || appName || `Litter-Robot ${serial.slice(-4)}`;
    const isNew = !accessory;
    if (!accessory) {
      accessory = new this.api.platformAccessory<AccessoryContext>(name, uuid);
      this.cached.set(uuid, accessory);
    }
    accessory.context = { ...accessory.context, kind: 'cloud', id: serial, name, toggles: toggles(config ?? {}) };

    const robot = new CloudRobot(this.cloud!, serial, { confirmTimeoutMs: 0 });
    const handler = new LitterRobotAccessory(
      {
        api: this.api,
        log: this.log,
        afterWrite: () => {
          robot.requestState().catch((err) => this.log.debug(`[${name}] requestState failed: ${err instanceof Error ? err.message : err}`));
          this.cloudPoller?.soon(...REFRESH_AFTER_WRITE_MS);
        },
      },
      accessory,
      robot,
    );
    if (isNew) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.log.info(`[${name}] added (serial ${serial})`);
    } else {
      this.api.updatePlatformAccessories([accessory]);
    }
    this.cloudRobots.set(serial, handler);
    return handler;
  }

  // ESPHome robots ----------------------------------------------------------

  private validESPHome(): ESPHomeRobotConfig[] {
    const out: ESPHomeRobotConfig[] = [];
    const seen = new Set<string>();
    for (const [i, robot] of (this.config.esphome ?? []).entries()) {
      if (isBlankESPHomeRobot(robot)) {
        this.log.debug(`ignoring empty ESPHome entry ${i + 1}`);
        continue;
      }
      const label = robot.name || `ESPHome robot ${i + 1}`;
      if (!robot.name) {
        this.log.error(`${label}: "name" is required`);
        continue;
      }
      if (!robot.mac && !robot.host) {
        this.log.error(`[${label}] set "mac" (recommended) or "host"`);
        continue;
      }
      const key = robot.mac ? normalizeMac(robot.mac) : robot.host!;
      if (seen.has(key)) {
        this.log.error(`[${label}] is configured more than once`);
        continue;
      }
      seen.add(key);
      out.push(robot);
    }
    return out;
  }

  private async launchESPHome(keep: Set<string>): Promise<void> {
    const robots = this.validESPHome();
    if (robots.length === 0) {
      return;
    }
    const discovery = this.config.discovery !== false;
    let found: DiscoveredRobot[] = [];
    if (discovery && robots.some((r) => r.mac)) {
      try {
        found = await discover({ timeoutMs: 3000, all: true });
      } catch (err) {
        this.log.warn(`discovery failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    for (const config of robots) {
      const mac = config.mac ? normalizeMac(config.mac) : undefined;
      const uuid = this.api.hap.uuid.generate(`litterrobot4:esphome:${mac ?? config.host}`);
      const cached = this.cached.get(uuid);
      const host = (mac && found.find((d) => d.mac === mac)?.address) || config.host || cached?.context.host;
      if (!host) {
        this.log.error(`[${config.name}] not found on the network; set "host" or check the MAC address`);
        if (cached) {
          keep.add(uuid);
        }
        continue;
      }
      keep.add(uuid);
      this.addESPHomeRobot(uuid, config, mac, host, cached);
    }
  }

  private addESPHomeRobot(
    uuid: string,
    config: ESPHomeRobotConfig,
    mac: string | undefined,
    host: string,
    cached: PlatformAccessory<AccessoryContext> | undefined,
  ): void {
    let accessory = cached;
    const isNew = !accessory;
    if (!accessory) {
      accessory = new this.api.platformAccessory<AccessoryContext>(config.name, uuid);
      this.cached.set(uuid, accessory);
    }
    accessory.context = { ...accessory.context, kind: 'esphome', id: mac ?? host, name: config.name, toggles: toggles(config), host, mac };

    const robot = new ESPHomeRobot({ host, username: config.username, password: config.password });
    let poller: Poller;
    let relocating = false;
    const handler = new LitterRobotAccessory({ api: this.api, log: this.log, afterWrite: () => poller.soon(1500) }, accessory, robot);
    poller = new Poller(async () => {
      try {
        handler.update(await robot.getState());
      } catch (err) {
        handler.fail(err);
        if (handler.unavailable && mac && this.config.discovery !== false && !relocating) {
          relocating = true;
          try {
            const moved = await findRobot(mac, { timeoutMs: 3000 });
            if (moved && `http://${moved.address}` !== robot.url) {
              this.log.info(`[${config.name}] address changed to ${moved.address}`);
              robot.setHost(moved.address);
              accessory.context.host = moved.address;
              this.api.updatePlatformAccessories([accessory]);
              poller.soon(0);
            }
          } catch {
            // try again after the next failure
          } finally {
            relocating = false;
          }
        }
      }
    }, this.pollIntervalMs, (err) => this.log.error(`[${config.name}] poll failed: ${err instanceof Error ? err.stack : err}`));

    if (isNew) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.log.info(`[${config.name}] added at ${host}`);
    } else {
      this.api.updatePlatformAccessories([accessory]);
    }
    this.pollers.push(poller);
    void poller.start();
  }
}
