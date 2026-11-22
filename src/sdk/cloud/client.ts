/**
 * Whisker cloud GraphQL client for the Litter-Robot 4. The API is not
 * published; the queries follow pylitterbot (MIT).
 */
import { setTimeout as sleep } from 'node:timers/promises';

import {
  BRIGHTNESS_PERCENT,
  validateCleanCycleDelay,
  type Brightness,
  type NightLightMode,
  type Robot,
  type State,
} from '../types.js';
import type { WhiskerAuth } from './auth.js';
import { parseRobot, type RobotData } from './status.js';

export const GRAPHQL_ENDPOINT = 'https://lr4.iothings.site/graphql';

/** Sent with commands, so they show up as coming from this plugin in the robot's activity. */
export const COMMAND_SOURCE = 'homebridge-litterrobot4';

/** The field selection for a Litter-Robot 4. */
export const ROBOT_FIELDS = `{
  unitId name serial userId espFirmware picFirmwareVersion picFirmwareVersionHex
  laserBoardFirmwareVersion laserBoardFirmwareVersionHex wifiRssi unitPowerType
  catWeight displayCode unitTimezone unitTime cleanCycleWaitTime isKeypadLockout
  nightLightMode nightLightBrightness isPanelSleepMode panelSleepTime panelWakeTime
  weekdaySleepModeEnabled {
    Sunday { sleepTime wakeTime isEnabled }
    Monday { sleepTime wakeTime isEnabled }
    Tuesday { sleepTime wakeTime isEnabled }
    Wednesday { sleepTime wakeTime isEnabled }
    Thursday { sleepTime wakeTime isEnabled }
    Friday { sleepTime wakeTime isEnabled }
    Saturday { sleepTime wakeTime isEnabled }
  }
  unitPowerStatus sleepStatus robotStatus globeMotorFaultStatus pinchStatus catDetect
  isBonnetRemoved isNightLightLEDOn odometerPowerCycles odometerCleanCycles
  panelBrightnessHigh panelBrightnessLow smartWeightEnabled odometerEmptyCycles
  odometerFilterCycles isDFIResetPending DFINumberOfCycles DFILevelPercent isDFIFull
  DFIFullCounter DFITriggerCount litterLevel DFILevelMM isCatDetectPending
  globeMotorRetractFaultStatus robotCycleStatus robotCycleState weightSensor isOnline
  isOnboarded isProvisioned isDebugModeActive lastSeen sessionId setupDateTime
  isFirmwareUpdateTriggered firmwareUpdateStatus wifiModeStatus isUSBPowerOn
  USBFaultStatus isDFIPartialFull isLaserDirty surfaceType hopperStatus
  scoopsSavedCount isHopperRemoved optimalLitterLevel litterLevelPercentage
  litterLevelState
}`;

/** Command names accepted by sendLitterRobot4Command. */
export const Commands = {
  CleanCycle: 'cleanCycle',
  KeyPadLockOutOff: 'keyPadLockOutOff',
  KeyPadLockOutOn: 'keyPadLockOutOn',
  NightLightModeAuto: 'nightLightModeAuto',
  NightLightModeOff: 'nightLightModeOff',
  NightLightModeOn: 'nightLightModeOn',
  PanelBrightnessLow: 'panelBrightnessLow',
  PanelBrightnessMed: 'panelBrightnessMed',
  PanelBrightnessHigh: 'panelBrightnessHigh',
  PowerOff: 'powerOff',
  PowerOn: 'powerOn',
  RequestState: 'requestState',
  SetClumpTime: 'setClumpTime',
  SetNightLightValue: 'setNightLightValue',
  ShortResetPress: 'shortResetPress',
} as const;

/** An error in a GraphQL response. */
export class GraphQLError extends Error {
  constructor(readonly messages: string[]) {
    super(`Whisker API: ${messages.join('; ')}`);
    this.name = 'GraphQLError';
  }
}

/** A command was accepted, but the robot did not report the change in time. */
export class NotConfirmedError extends Error {
  constructor(command: string) {
    super(`${command} was sent, but the robot did not report the change in time`);
    this.name = 'NotConfirmedError';
  }
}

/** One entry in a robot's activity history. */
export interface Activity {
  serial: string;
  measure: string;
  timestamp: string;
  value: unknown;
  actionValue: unknown;
  valueString: string | null;
  stateString: string | null;
  commandSource: string | null;
}

export interface CloudClientOptions {
  auth: WhiskerAuth;
  /** Overrides the GraphQL endpoint, for tests. */
  endpoint?: string;
  fetch?: typeof fetch;
}

/** Whisker cloud API client. */
export class WhiskerClient {
  readonly auth: WhiskerAuth;
  private readonly endpoint: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: CloudClientOptions) {
    this.auth = options.auth;
    this.endpoint = options.endpoint ?? GRAPHQL_ENDPOINT;
    this.fetchFn = options.fetch ?? fetch;
  }

  /** Runs a GraphQL query and returns its data field. Retries once with a fresh token on HTTP 401. */
  async query<T = Record<string, unknown>>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    let response = await this.post(await this.auth.idToken(), query, variables);
    if (response.status === 401) {
      await response.body?.cancel();
      const tokens = await this.auth.refresh();
      response = await this.post(tokens.idToken, query, variables);
    }
    const text = await response.text();
    let body: { data?: T; errors?: { message?: string }[]; message?: string };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new Error(`Whisker API: HTTP ${response.status}`);
    }
    if (body.errors?.length) {
      throw new GraphQLError(body.errors.map((e) => e.message ?? 'unknown error'));
    }
    if (!response.ok) {
      throw new Error(`Whisker API: HTTP ${response.status}${body.message ? `: ${body.message}` : ''}`);
    }
    return (body.data ?? {}) as T;
  }

  private post(token: string, query: string, variables: Record<string, unknown>): Promise<Response> {
    return this.fetchFn(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(15_000),
    });
  }

  /** Lists the Litter-Robot 4 units on the account. */
  async robots(): Promise<RobotData[]> {
    const userId = await this.auth.userId();
    const data = await this.query<{ getLitterRobot4ByUser?: RobotData[] | null }>(
      `query GetLR4($userId: String!) { getLitterRobot4ByUser(userId: $userId) ${ROBOT_FIELDS} }`,
      { userId },
    );
    return (data.getLitterRobot4ByUser ?? []).filter((r) => r && typeof r.serial === 'string' && r.serial !== '');
  }

  /** Fetches one robot. */
  async robot(serial: string): Promise<RobotData> {
    const data = await this.query<{ getLitterRobot4BySerial?: RobotData | null }>(
      `query GetLR4($serial: String!) { getLitterRobot4BySerial(serial: $serial) ${ROBOT_FIELDS} }`,
      { serial },
    );
    if (!data.getLitterRobot4BySerial) {
      throw new Error(`no Litter-Robot 4 with serial ${serial} on this account`);
    }
    return data.getLitterRobot4BySerial;
  }

  /** Sends a command, with an optional value that is sent as JSON. */
  async sendCommand(serial: string, command: string, value?: unknown): Promise<void> {
    const variables: Record<string, unknown> = { serial, command, commandSource: COMMAND_SOURCE };
    if (value !== undefined) {
      variables.value = JSON.stringify(value);
    }
    const data = await this.query<{ sendLitterRobot4Command?: string | null }>(
      `mutation sendCommand($serial: String!, $command: String!, $value: String, $commandSource: String) {
  sendLitterRobot4Command(input: {serial: $serial, command: $command, value: $value, commandSource: $commandSource})
}`,
      variables,
    );
    const result = data.sendLitterRobot4Command;
    if (typeof result === 'string' && result.includes('Error')) {
      throw new Error(`Whisker API: ${result}`);
    }
  }

  /** Recent activity between start and end. */
  async activity(serial: string, start: Date, end: Date, limit = 50): Promise<Activity[]> {
    const fmt = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');
    const data = await this.query<{ getLitterRobot4Activity?: Activity[] | null }>(
      `query GetLR4Activity($serial: String!, $startTimestamp: String, $endTimestamp: String, $limit: Int, $consumer: String) {
  getLitterRobot4Activity(serial: $serial, startTimestamp: $startTimestamp, endTimestamp: $endTimestamp, limit: $limit, consumer: $consumer) {
    serial measure timestamp value actionValue valueString stateString commandSource
  }
}`,
      { serial, startTimestamp: fmt(start), endTimestamp: fmt(end), limit, consumer: 'app' },
    );
    return data.getLitterRobot4Activity ?? [];
  }

  /** A robot on this account. */
  robotHandle(serial: string, options?: CloudRobotOptions): CloudRobot {
    return new CloudRobot(this, serial, options);
  }
}

export interface CloudRobotOptions {
  /**
   * How long to wait for the robot to report a change after a command, in
   * milliseconds (default 30000). 0 sends commands without waiting.
   */
  confirmTimeoutMs?: number;
  /** Time between state checks while waiting (default 1000). */
  pollIntervalMs?: number;
}

/**
 * A cloud robot. The cloud keeps the state the robot last reported, which
 * only changes when the robot reports again. After a command, CloudRobot
 * sends requestState and polls until the change shows up.
 */
export class CloudRobot implements Robot {
  confirmTimeoutMs: number;
  pollIntervalMs: number;

  constructor(
    readonly client: WhiskerClient,
    readonly serial: string,
    options: CloudRobotOptions = {},
  ) {
    this.confirmTimeoutMs = options.confirmTimeoutMs ?? 30_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
  }

  /** Fetches the raw robot data. */
  data(): Promise<RobotData> {
    return this.client.robot(this.serial);
  }

  async getState(): Promise<State> {
    return parseRobot(await this.data());
  }

  /** Asks the robot to report its state to the cloud. */
  requestState(): Promise<void> {
    return this.client.sendCommand(this.serial, Commands.RequestState);
  }

  /**
   * Sends a command, then waits until done() is true for the robot's data.
   * Without done, it only asks the robot to report its state. Throws
   * NotConfirmedError when the change does not show up in time.
   */
  async send(command: string, value?: unknown, done?: (d: RobotData) => boolean): Promise<void> {
    await this.client.sendCommand(this.serial, command, value);
    if (this.confirmTimeoutMs <= 0) {
      return;
    }
    if (!done) {
      await this.requestState();
      return;
    }
    const deadline = Date.now() + this.confirmTimeoutMs;
    for (;;) {
      await this.requestState();
      await sleep(this.pollIntervalMs);
      if (done(await this.data())) {
        return;
      }
      if (Date.now() > deadline) {
        throw new NotConfirmedError(command);
      }
    }
  }

  clean(): Promise<void> {
    return this.send(Commands.CleanCycle, undefined, (d) => d.robotStatus !== 'ROBOT_IDLE');
  }

  reset(): Promise<void> {
    return this.send(Commands.ShortResetPress);
  }

  setPower(on: boolean): Promise<void> {
    return this.send(on ? Commands.PowerOn : Commands.PowerOff, undefined, (d) => (d.unitPowerStatus === 'ON') === on);
  }

  setPanelLock(on: boolean): Promise<void> {
    return this.send(on ? Commands.KeyPadLockOutOn : Commands.KeyPadLockOutOff, undefined, (d) => d.isKeypadLockout === on);
  }

  setNightLightMode(mode: NightLightMode): Promise<void> {
    const command = { off: Commands.NightLightModeOff, on: Commands.NightLightModeOn, auto: Commands.NightLightModeAuto }[mode];
    if (!command) {
      return Promise.reject(new RangeError(`unknown night light mode ${mode}`));
    }
    return this.send(command, undefined, (d) => parseRobot(d).nightLightMode === mode);
  }

  setNightLightBrightness(level: Brightness): Promise<void> {
    const value = BRIGHTNESS_PERCENT[level];
    if (!value) {
      return Promise.reject(new RangeError(`unknown brightness ${level}`));
    }
    return this.send(Commands.SetNightLightValue, { nightLightPower: value }, (d) => d.nightLightBrightness === value);
  }

  setPanelBrightness(level: Brightness): Promise<void> {
    const command = { low: Commands.PanelBrightnessLow, medium: Commands.PanelBrightnessMed, high: Commands.PanelBrightnessHigh }[level];
    if (!command) {
      return Promise.reject(new RangeError(`unknown brightness ${level}`));
    }
    return this.send(command, undefined, (d) => parseRobot(d).panelBrightness === level);
  }

  setCleanCycleDelay(minutes: number): Promise<void> {
    validateCleanCycleDelay(minutes);
    return this.send(Commands.SetClumpTime, { clumpTime: minutes }, (d) => d.cleanCycleWaitTime === minutes);
  }
}
