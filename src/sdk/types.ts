/** Types shared by the cloud and ESPHome backends. */

/** A robot status, as the Whisker app reports it. */
export interface Status {
  code: string;
  text: string;
}

const status = (code: string, text: string): Status => Object.freeze({ code, text });

/** Known statuses. */
export const Statuses = {
  BonnetRemoved: status('BR', 'Bonnet Removed'),
  CleanCycleComplete: status('CCC', 'Clean Cycle Complete'),
  CleanCycle: status('CCP', 'Clean Cycle In Progress'),
  CatDetected: status('CD', 'Cat Detected'),
  CatSensorFault: status('CSF', 'Cat Sensor Fault'),
  CatSensorInterrupted: status('CSI', 'Cat Sensor Interrupted'),
  CatSensorTiming: status('CST', 'Cat Sensor Timing'),
  DrawerFull1: status('DF1', 'Drawer Almost Full - 2 Cycles Left'),
  DrawerFull2: status('DF2', 'Drawer Almost Full - 1 Cycle Left'),
  DrawerFull: status('DFS', 'Drawer Full'),
  DumpHomeFault: status('DHF', 'Dump + Home Position Fault'),
  DumpPositionFault: status('DPF', 'Dump Position Fault'),
  EmptyCycle: status('EC', 'Empty Cycle'),
  HomePositionFault: status('HPF', 'Home Position Fault'),
  Off: status('OFF', 'Off'),
  Offline: status('OFFLINE', 'Offline'),
  OverTorqueFault: status('OTF', 'Over Torque Fault'),
  Paused: status('P', 'Clean Cycle Paused'),
  PinchDetect: status('PD', 'Pinch Detect'),
  PowerDown: status('PWRD', 'Powering Down'),
  PowerUp: status('PWRU', 'Powering Up'),
  Ready: status('RDY', 'Ready'),
  StartupCatSensorFault: status('SCF', 'Cat Sensor Fault At Startup'),
  StartupDrawerFull: status('SDF', 'Drawer Full At Startup'),
  StartupPinchDetect: status('SPF', 'Pinch Detect At Startup'),
  Unknown: status('', 'Unknown'),
} as const;

/** Statuses during which the robot is cleaning or emptying. */
export const CYCLING_CODES: ReadonlySet<string> = new Set(['CCP', 'EC', 'P', 'PWRU', 'PWRD']);

/** Statuses that are faults. */
export const FAULT_CODES: ReadonlySet<string> = new Set(['CSF', 'DHF', 'DPF', 'HPF', 'OTF', 'PD', 'SCF', 'SPF', 'FAULT']);

export type NightLightMode = 'off' | 'on' | 'auto';
export type Brightness = 'low' | 'medium' | 'high';

export const NIGHT_LIGHT_MODES: readonly NightLightMode[] = ['off', 'on', 'auto'];
export const BRIGHTNESS_LEVELS: readonly Brightness[] = ['low', 'medium', 'high'];

/** The Whisker API's value for each brightness level. */
export const BRIGHTNESS_PERCENT: Readonly<Record<Brightness, number>> = { low: 25, medium: 50, high: 100 };

/** Maps 25, 50 and 100 to a brightness level. */
export function brightnessFromPercent(value: number | undefined): Brightness | undefined {
  return BRIGHTNESS_LEVELS.find((b) => BRIGHTNESS_PERCENT[b] === value);
}

/** Wait times after a cat leaves before cleaning, in minutes, that the robot accepts. */
export const CLEAN_CYCLE_DELAYS: readonly number[] = [3, 7, 15, 25, 30];

/** Throws a RangeError for a clean cycle delay the robot does not accept. */
export function validateCleanCycleDelay(minutes: number): void {
  if (!CLEAN_CYCLE_DELAYS.includes(minutes)) {
    throw new RangeError(`clean cycle delay must be one of ${CLEAN_CYCLE_DELAYS.join(', ')} minutes, not ${minutes}`);
  }
}

/** A snapshot of a robot. Fields are undefined when the backend does not report them. */
export interface State {
  name?: string;
  serial?: string;
  status: Status;
  online: boolean;
  power?: boolean;
  /** AC (mains), DC (battery backup) or NC (not connected). */
  powerType?: string;
  /** Percentages. */
  litterLevel?: number;
  wasteLevel?: number;
  /** The app's litter rating: OVERFILL, OPTIMAL, REFILL, LOW or EMPTY. */
  litterLevelState?: string;
  drawerFull?: boolean;
  /** Whether a cat is in the robot right now. */
  catDetected?: boolean;
  /** Pounds. */
  catWeight?: number;
  nightLightMode?: NightLightMode;
  nightLightBrightness?: Brightness;
  panelBrightness?: Brightness;
  panelLock?: boolean;
  /** Minutes. */
  cleanCycleDelay?: number;
  sleeping?: boolean;
  cleanCycles?: number;
  firmware?: string;
  wifiRssi?: number;
  lastSeen?: Date;
  fault?: string;
}

/** A Litter-Robot 4 that can be read and controlled. */
export interface Robot {
  getState(): Promise<State>;
  clean(): Promise<void>;
  reset(): Promise<void>;
  setPower(on: boolean): Promise<void>;
  setPanelLock(on: boolean): Promise<void>;
  setNightLightMode(mode: NightLightMode): Promise<void>;
  setNightLightBrightness(level: Brightness): Promise<void>;
  setPanelBrightness(level: Brightness): Promise<void>;
  setCleanCycleDelay(minutes: number): Promise<void>;
}

/** Uppercases a MAC address and strips separators. */
export function normalizeMac(mac: string): string {
  return mac.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
}
