import type { API } from 'homebridge';

import { LitterRobotPlatform } from './platform.js';
import { PLATFORM_NAME } from './settings.js';

/** Homebridge entry point. */
export default (api: API): void => {
  api.registerPlatform(PLATFORM_NAME, LitterRobotPlatform);
};

export { LitterRobotPlatform } from './platform.js';
export { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
export type { CloudRobotConfig, ESPHomeRobotConfig, LitterRobotPlatformConfig, ServiceToggles } from './settings.js';
