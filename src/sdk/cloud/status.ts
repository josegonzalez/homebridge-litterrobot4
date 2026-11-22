import { brightnessFromPercent, NIGHT_LIGHT_MODES, Statuses, type NightLightMode, type State, type Status } from '../types.js';

/** The raw data the Whisker API returns for a robot. */
export type RobotData = Record<string, unknown>;

const ROBOT_STATUS: Record<string, Status> = {
  ROBOT_BONNET: Statuses.BonnetRemoved,
  ROBOT_CAT_DETECT: Statuses.CatDetected,
  ROBOT_CAT_DETECT_DELAY: Statuses.CatSensorTiming,
  ROBOT_CLEAN: Statuses.CleanCycle,
  ROBOT_EMPTY: Statuses.EmptyCycle,
  ROBOT_FIND_DUMP: Statuses.CleanCycle,
  ROBOT_IDLE: Statuses.Ready,
  ROBOT_POWER_DOWN: Statuses.PowerDown,
  ROBOT_POWER_OFF: Statuses.Off,
  ROBOT_POWER_UP: Statuses.PowerUp,
};

const CYCLE_STATE: Record<string, Status> = {
  CYCLE_STATE_CAT_DETECT: Statuses.CatSensorInterrupted,
  CYCLE_STATE_PAUSE: Statuses.Paused,
};

const DISPLAY_FAULT: Record<string, Status> = {
  DC_CAT_DETECT_30M: Statuses.CatSensorFault,
  DC_MTR_FAULT_OT_AMP: Statuses.OverTorqueFault,
  DC_MTR_FAULT_OT_SLP: Statuses.OverTorqueFault,
  DC_MTR_FAULT_PINCH: Statuses.PinchDetect,
};

const str = (d: RobotData, k: string): string | undefined => (typeof d[k] === 'string' ? (d[k] as string) : undefined);
const num = (d: RobotData, k: string): number | undefined => (typeof d[k] === 'number' ? (d[k] as number) : undefined);
const bool = (d: RobotData, k: string): boolean | undefined => (typeof d[k] === 'boolean' ? (d[k] as boolean) : undefined);

/** The robot's status, worked out the same way as the Whisker app and pylitterbot. */
export function robotStatus(d: RobotData): Status {
  if (d.isOnline !== true) {
    return Statuses.Offline;
  }
  if (d.unitPowerStatus !== 'ON') {
    return Statuses.Off;
  }
  const display = str(d, 'displayCode') ?? '';
  const fault = DISPLAY_FAULT[display];
  if (fault) {
    return fault;
  }
  const cycle = CYCLE_STATE[str(d, 'robotCycleState') ?? ''];
  if (cycle) {
    return cycle;
  }
  const s = ROBOT_STATUS[str(d, 'robotStatus') ?? ''];
  if (!s) {
    return Statuses.Unknown;
  }
  if (s === Statuses.Ready) {
    if (display === 'DC_CAT_DETECT') {
      return Statuses.CatDetected;
    }
    if (d.isDFIFull === true) {
      return Statuses.DrawerFull;
    }
  }
  return s;
}

/** The litter level as a percentage. */
export function litterLevel(d: RobotData): number | undefined {
  const pct = num(d, 'litterLevelPercentage');
  if (pct !== undefined) {
    return Math.round(pct * 1000) / 10;
  }
  const level = num(d, 'litterLevel');
  if (level === undefined) {
    return undefined;
  }
  // pylitterbot: max(round(100 - (level - 440) / 0.6, -1), 0)
  return Math.max(Math.round((100 - (level - 440) / 0.6) / 10) * 10, 0);
}

/** Converts raw robot data to a State. */
export function parseRobot(d: RobotData): State {
  const s: State = {
    name: str(d, 'name'),
    serial: str(d, 'serial'),
    status: robotStatus(d),
    online: d.isOnline === true,
    power: d.unitPowerStatus === undefined ? undefined : d.unitPowerStatus === 'ON',
    powerType: str(d, 'unitPowerType'),
    litterLevel: litterLevel(d),
    litterLevelState: str(d, 'litterLevelState'),
    wasteLevel: num(d, 'DFILevelPercent'),
    drawerFull: bool(d, 'isDFIFull'),
    catWeight: num(d, 'catWeight'),
    nightLightBrightness: brightnessFromPercent(num(d, 'nightLightBrightness')),
    panelBrightness: brightnessFromPercent(num(d, 'panelBrightnessHigh')),
    panelLock: bool(d, 'isKeypadLockout'),
    cleanCycleDelay: num(d, 'cleanCycleWaitTime'),
    cleanCycles: num(d, 'odometerCleanCycles'),
    wifiRssi: num(d, 'wifiRssi'),
  };
  const mode = str(d, 'nightLightMode')?.toLowerCase();
  if (mode && NIGHT_LIGHT_MODES.includes(mode as NightLightMode)) {
    s.nightLightMode = mode as NightLightMode;
  }
  const sleep = str(d, 'sleepStatus');
  if (sleep) {
    s.sleeping = sleep !== 'WAKE';
  }
  const catDetect = str(d, 'catDetect');
  if (catDetect !== undefined || s.status.code) {
    s.catDetected = s.status === Statuses.CatDetected || (catDetect !== undefined && catDetect !== 'CAT_DETECT_CLEAR');
  }
  const lastSeen = str(d, 'lastSeen');
  if (lastSeen && !Number.isNaN(Date.parse(lastSeen))) {
    s.lastSeen = new Date(lastSeen);
  }
  const display = str(d, 'displayCode');
  if (display && DISPLAY_FAULT[display]) {
    s.fault = display;
  }
  const firmware = [
    ['ESP', str(d, 'espFirmware')],
    ['PIC', str(d, 'picFirmwareVersion')],
    ['laser', str(d, 'laserBoardFirmwareVersion')],
  ]
    .filter(([, v]) => v)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
  if (firmware) {
    s.firmware = firmware;
  }
  return s;
}
