/**
 * Litter-Robot 4 SDK. Import from "@josediazgonzalez/homebridge-litterrobot4/sdk"
 * to use it without Homebridge.
 *
 * Stock robots are controlled through the Whisker cloud, whose API details
 * follow the MIT licensed pylitterbot (https://github.com/natekspencer/pylitterbot).
 * Robots running the open source ESPHome firmware are controlled locally.
 */
export { AuthError, COGNITO_CLIENT_ID, COGNITO_ENDPOINT, jwtClaims, userIdFromToken, WhiskerAuth } from './cloud/auth.js';
export type { AuthOptions, Tokens } from './cloud/auth.js';
export { CloudRobot, Commands, COMMAND_SOURCE, GRAPHQL_ENDPOINT, GraphQLError, NotConfirmedError, ROBOT_FIELDS, WhiskerClient } from './cloud/client.js';
export type { Activity, CloudClientOptions, CloudRobotOptions } from './cloud/client.js';
export { litterLevel, parseRobot, robotStatus } from './cloud/status.js';
export type { RobotData } from './cloud/status.js';
export { DEFAULT_USERNAME, Entities, EntityNotFoundError, ESPHomeRobot, objectId, UnauthorizedError } from './esphome/client.js';
export type { Entity, ESPHomeOptions } from './esphome/client.js';
export { assemble, discover, findRobot, isRobotName, SERVICE_TYPE } from './esphome/discovery.js';
export type { DiscoveredRobot, DiscoverOptions } from './esphome/discovery.js';
export {
  BRIGHTNESS_LEVELS,
  BRIGHTNESS_PERCENT,
  brightnessFromPercent,
  CLEAN_CYCLE_DELAYS,
  CYCLING_CODES,
  FAULT_CODES,
  NIGHT_LIGHT_MODES,
  normalizeMac,
  Statuses,
  validateCleanCycleDelay,
} from './types.js';
export type { Brightness, NightLightMode, Robot, State, Status } from './types.js';
