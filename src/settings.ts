import type { PlatformConfig } from 'homebridge';

export const PLUGIN_NAME = '@josediazgonzalez/homebridge-litterrobot4';
export const PLATFORM_NAME = 'LitterRobot4';

/** Optional HomeKit services. All default to true when the robot reports the data. */
export interface ServiceToggles {
  cleanSwitch?: boolean;
  wasteDrawer?: boolean;
  litterLevel?: boolean;
  catSensor?: boolean;
  nightLight?: boolean;
  panelLockSwitch?: boolean;
  powerSwitch?: boolean;
}

export const SERVICE_TOGGLES: readonly (keyof ServiceToggles)[] = [
  'cleanSwitch',
  'wasteDrawer',
  'litterLevel',
  'catSensor',
  'nightLight',
  'panelLockSwitch',
  'powerSwitch',
];

/** Settings for a robot on the Whisker account. Robots without an entry are added with the defaults. */
export interface CloudRobotConfig extends ServiceToggles {
  serial: string;
  /** Name shown in HomeKit. Defaults to the name in the Whisker app. */
  name?: string;
  /** Leave this robot out of HomeKit. */
  hidden?: boolean;
}

/** A robot running ESPHome firmware. */
export interface ESPHomeRobotConfig extends ServiceToggles {
  name: string;
  /** IP address or hostname. Optional when the MAC address is set. */
  host?: string;
  /** MAC address; used to find the robot with mDNS and as its stable identity. */
  mac?: string;
  /** Web server username (default "user"). */
  username?: string;
  /** Web server password. Leave empty when auth is turned off. */
  password?: string;
}

export interface LitterRobotPlatformConfig extends PlatformConfig {
  /** Whisker account, for robots with stock firmware. */
  email?: string;
  password?: string;
  robots?: CloudRobotConfig[];
  esphome?: ESPHomeRobotConfig[];
  /** Seconds between state polls (default 30, minimum 10). */
  pollInterval?: number;
  /** Find ESPHome robots with mDNS and follow address changes (default true). */
  discovery?: boolean;
}

const filled = (v: unknown) => typeof v === 'string' && v.trim() !== '';

/**
 * Whether an entry is an empty row, such as the one the Homebridge settings
 * form adds to an empty list. These only hold the form's defaults.
 */
export function isBlankCloudRobot(robot: Partial<CloudRobotConfig> | null | undefined): boolean {
  return !robot || ![robot.serial, robot.name].some(filled);
}

export function isBlankESPHomeRobot(robot: Partial<ESPHomeRobotConfig> | null | undefined): boolean {
  return !robot || ![robot.name, robot.host, robot.mac, robot.password].some(filled);
}

export const DEFAULT_POLL_INTERVAL = 30;
export const MIN_POLL_INTERVAL = 10;
