/**
 * Server side of the custom settings UI. The Homebridge UI runs this script
 * while the plugin settings are open; the page in public/index.html calls the
 * routes below with homebridge.request().
 */
import { HomebridgePluginUiServer } from '@homebridge/plugin-ui-utils';

import { accountRobots, discoverRobots, verifyESPHome, type AccountRequest, type VerifyRequest } from './routes.js';

class LitterRobotUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.onRequest('/account', (body: AccountRequest) => accountRobots(body));
    this.onRequest('/discover', () => discoverRobots());
    this.onRequest('/verify', (body: VerifyRequest) => verifyESPHome(body));
    this.ready();
  }
}

// Only start when run by the Homebridge UI, not when imported by tests.
if (process.send) {
  new LitterRobotUiServer();
}
