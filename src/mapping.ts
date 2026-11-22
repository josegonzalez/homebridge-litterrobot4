/**
 * Pure mappings between robot state and HomeKit values, kept apart from
 * Homebridge so they can be unit tested.
 */
import { BRIGHTNESS_PERCENT, CYCLING_CODES, FAULT_CODES, type Brightness, type State } from './sdk/index.js';

/** HomeKit characteristic values used here (from the HAP specification). */
export const HK = {
  FilterChangeIndication: { FILTER_OK: 0, CHANGE_FILTER: 1 },
  OccupancyDetected: { NOT_DETECTED: 0, DETECTED: 1 },
  StatusFault: { NO_FAULT: 0, GENERAL_FAULT: 1 },
} as const;

const clamp = (v: number) => Math.min(100, Math.max(0, Math.round(v)));

const DRAWER_FULL_CODES = new Set(['DFS', 'DF1', 'DF2', 'SDF']);
const LOW_LITTER_STATES = new Set(['LOW', 'EMPTY']);

/** Whether the robot is cleaning or emptying. */
export const cycling = (s: State): boolean => CYCLING_CODES.has(s.status.code);

/** Waste drawer space left, as a filter life percentage. */
export const wasteLife = (s: State): number => clamp(100 - (s.wasteLevel ?? 0));

export const wasteChange = (s: State): number =>
  s.drawerFull || DRAWER_FULL_CODES.has(s.status.code) ? HK.FilterChangeIndication.CHANGE_FILTER : HK.FilterChangeIndication.FILTER_OK;

/** Litter level, as a filter life percentage. */
export const litterLife = (s: State): number => clamp(s.litterLevel ?? 0);

export const litterChange = (s: State): number =>
  LOW_LITTER_STATES.has((s.litterLevelState ?? '').toUpperCase()) ? HK.FilterChangeIndication.CHANGE_FILTER : HK.FilterChangeIndication.FILTER_OK;

export const occupancy = (s: State): number => (s.catDetected ? HK.OccupancyDetected.DETECTED : HK.OccupancyDetected.NOT_DETECTED);

export const statusFault = (s: State): number => (FAULT_CODES.has(s.status.code) ? HK.StatusFault.GENERAL_FAULT : HK.StatusFault.NO_FAULT);

/** The night light is on in on and auto mode. */
export const nightLightOn = (s: State): boolean => s.nightLightMode !== undefined && s.nightLightMode !== 'off';

export const nightLightBrightness = (s: State): number => BRIGHTNESS_PERCENT[s.nightLightBrightness ?? 'high'];

/** Snaps a HomeKit brightness to the nearest of the robot's three levels. */
export function brightnessLevel(value: number): Brightness {
  if (value <= 37) return 'low';
  if (value <= 75) return 'medium';
  return 'high';
}

/** A HomeKit firmware revision ("1.1.75") from the robot's firmware string. */
export function firmwareRevision(firmware: string | undefined): string | undefined {
  const m = /ESP (\d+(?:\.\d+){0,2})/.exec(firmware ?? '');
  return m?.[1];
}
