# homebridge-litterrobot4

A Homebridge plugin for Whisker Litter-Robot 4 units. It also ships a standalone TypeScript SDK for the same APIs.

- Robots with stock firmware are controlled through the Whisker cloud with the account you use in the Whisker app, the same way the app and Home Assistant do it. Stock firmware has no local API.
- Robots flashed with the open source [ESPHome firmware](https://codeberg.org/Joseph-DiGiovanni/esphome-litter-robot) are controlled over your local network, and found with mDNS.
- State is cached and refreshed in the background, so HomeKit reads never wait on the network.
- No runtime dependencies besides Homebridge's own settings UI library: the plugin uses Node's built-in `fetch`, crypto and networking.

## What shows up in HomeKit

| Robot feature | HomeKit | Notes |
|---|---|---|
| Clean cycle | Switch "Clean" | Turning it on starts a clean cycle. It stays on while the robot cleans or empties, and turns off when it is done. A cycle cannot be stopped from HomeKit. |
| Waste drawer | Filter Maintenance "Waste Drawer" | Life level is the space left in the drawer. "Change filter" shows when the drawer is full. |
| Litter level | Filter Maintenance "Litter" | Life level is the litter level. "Change filter" shows when the Whisker app rates the litter low or empty. |
| Cat in the robot | Occupancy Sensor "Cat" | Status Fault shows robot faults such as a pinch or motor fault |
| Night light | Lightbulb "Night Light" | On means on or auto. Brightness snaps to low, medium or high (25%, 50% or 100%). |
| Control panel lock | Switch "Panel Lock" | |
| Power | Switch "Power" | |
| Serial, firmware | Accessory information | |

Each service can be turned off per robot, and services the robot does not report are left out. The clean cycle delay and panel brightness have no HomeKit control. They are available through the [SDK](#sdk).

## Install

Search for "Litter-Robot 4" in the Homebridge UI plugins tab, or run:

```shell
npm install -g @josediazgonzalez/homebridge-litterrobot4
```

Requires Homebridge 1.8 or newer and Node.js 22, 24 or 26.

### Install from source

Run these on the machine that runs Homebridge, in the same place Homebridge installs its plugins. With a global npm install of Homebridge, that is `npm install -g`. With the official Homebridge apt package or Raspberry Pi image, open the terminal in the Homebridge UI and add `--prefix /var/lib/homebridge` instead of `-g`. Restart Homebridge afterwards.

From GitHub, which builds the plugin during the install and needs `git`:

```shell
npm install -g github:josegonzalez/homebridge-litterrobot4
# or a specific release or branch
npm install -g github:josegonzalez/homebridge-litterrobot4#v0.1.0
```

From a checkout, by building a package file and installing that:

```shell
git clone https://github.com/josegonzalez/homebridge-litterrobot4.git
cd homebridge-litterrobot4
npm ci
npm run build
npm pack
npm install -g ./josediazgonzalez-homebridge-litterrobot4-*.tgz
```

## Setup

Open the plugin's settings in the Homebridge UI.

- **Stock robots:** under "Whisker account", enter the email and password you use in the Whisker app and click "Sign in and check". The account is saved once Whisker accepts it. Every Litter-Robot 4 on the account is added to HomeKit with the name it has in the app. Use "Hide from HomeKit" to leave one out, or "Customize a Robot" to rename it or turn services off.
- **ESPHome robots:** click "Search the network", then "Set up" on a robot and enter its web server username and password from the firmware config (`web_server: auth:`). The example config uses the username `user`. The plugin checks the credentials before saving.

The Whisker password is stored in the Homebridge config. The plugin also caches its Whisker session in the Homebridge storage folder (`litterrobot4-tokens.json`, readable only by the Homebridge user), so a restart does not need a new sign in.

### Manual configuration

```json
{
  "platform": "LitterRobot4",
  "email": "you@example.com",
  "password": "your Whisker password",
  "robots": [
    { "serial": "LR4C000001", "name": "Upstairs Litter-Robot" },
    { "serial": "LR4C000002", "hidden": true }
  ],
  "esphome": [
    { "name": "Garage Litter-Robot", "mac": "7C:9E:BD:01:02:03", "password": "web server password" }
  ]
}
```

| Option | Default | Description |
|---|---|---|
| `email`, `password` | | Whisker account, for robots with stock firmware |
| `robots[].serial` | | A robot on the account. Robots without an entry are added with the defaults. |
| `robots[].name` | name in the app | Name shown in HomeKit |
| `robots[].hidden` | `false` | Leave the robot out of HomeKit |
| `esphome[].name` | | Name shown in HomeKit |
| `esphome[].mac` | | MAC address. Recommended: the plugin finds the robot with it and follows IP address changes. |
| `esphome[].host` | | IP address or hostname, optionally with a port. Optional when `mac` is set. |
| `esphome[].username`, `password` | `user` | Web server credentials. Leave the password empty if auth is off. |
| `cleanSwitch`, `wasteDrawer`, `litterLevel`, `catSensor`, `nightLight`, `panelLockSwitch`, `powerSwitch` | `true` | Turn services off, per entry in `robots` or `esphome` |
| `pollInterval` | `30` | Seconds between background state reads (minimum 10) |
| `discovery` | `true` | Find ESPHome robots with mDNS and follow address changes |

## How it talks to the robots

- **Cloud reads:** every `pollInterval` seconds, one request lists all the robots on the account, and their cached state is updated. HomeKit reads are answered from the cache. Only changed values are pushed to HomeKit.
- **Cloud writes:** the cache is updated straight away and the command is sent. The cloud only shows a change once the robot reports it, so the plugin asks the robot to report its state and reads again 4 and 12 seconds later.
- **No live updates:** the Whisker cloud also offers a realtime subscription, but in testing it sent only keepalives, even through clean cycles, so the plugin polls instead.
- **ESPHome:** each robot is read every `pollInterval` seconds over its web server, and again 1.5 seconds after a write.
- **Failures:** after two failed reads in a row, or when the Whisker cloud reports the robot as offline, HomeKit shows it as not responding. ESPHome robots are looked up again with mDNS in case their address changed.

## SDK

The clients can be used without Homebridge:

```ts
import { WhiskerAuth, WhiskerClient, parseRobot } from '@josediazgonzalez/homebridge-litterrobot4/sdk';

const auth = new WhiskerAuth({ email: process.env.WHISKER_EMAIL, password: process.env.WHISKER_PASSWORD });
const client = new WhiskerClient({ auth });

for (const data of await client.robots()) {
  const state = parseRobot(data);
  console.log(state.name, state.status.text, state.litterLevel, state.wasteLevel);
}

const robot = client.robotHandle('LR4C000001');
await robot.setNightLightMode('auto'); // waits until the robot reports the change
```

```ts
import { discover, ESPHomeRobot } from '@josediazgonzalez/homebridge-litterrobot4/sdk';

const [found] = await discover();
const robot = new ESPHomeRobot({ host: found.address, username: 'user', password: process.env.ESPHOME_PASSWORD });
console.log(await robot.getState());
await robot.clean();
```

| Export | Description |
|---|---|
| `WhiskerAuth` | Cognito sign in with `login()`, `idToken()`, `refresh()`, and an `onTokens` callback for caching |
| `WhiskerClient` | `robots()`, `robot(serial)`, `sendCommand(serial, command, value?)`, `activity(serial, start, end)`, `robotHandle(serial)` |
| `CloudRobot` | A robot on the account. Each command waits until the robot reports the change, or throws `NotConfirmedError` after `confirmTimeoutMs`. |
| `ESPHomeRobot` | A robot running ESPHome firmware, with `get()` and `post()` for any entity |
| `Robot`, `State`, `Status`, `Statuses` | The interface both robots implement, and their state |
| `discover(options?)`, `findRobot(mac)` | Find ESPHome robots with mDNS |
| `parseRobot(data)` | Converts raw cloud data to a `State` |

## Troubleshooting

- **Sign in fails:** use the same email and password as the Whisker app. "Sign in and check" in the settings shows the error from Whisker.
- **Not responding:** the Whisker cloud is unreachable, or reports the robot as offline. Check that the robot shows as online in the Whisker app.
- **ESPHome robot not found:** mDNS can be blocked by Docker bridge networking, VLANs or some mesh Wi-Fi systems. Run Homebridge with host networking, or set `host`.
- **Debug logging:** start Homebridge with `-D` to see every failed poll.

The Whisker cloud API is not published, and Whisker may change it at any time.

## Development

```shell
npm install
npm test
```

Tests use Node's built-in test runner against a fake Whisker cloud, a fake ESPHome web server and the real HomeKit (HAP) classes, so `npm test` never contacts your account or robots. See [RELEASING.md](RELEASING.md) for how releases are published.

To try a working copy, including its settings page, in a throwaway Homebridge with the Homebridge UI:

```shell
npm run dev:ui
```

It installs Homebridge and the Homebridge UI into `tmp/dev-homebridge` (outside the plugin's own dependencies), links this checkout as a plugin, and starts both. The UI only listens on `127.0.0.1` and keeps its login: on first start, open the printed URL and create an admin account. Set the plugin up through its settings page like a user would. The configuration and the UI account are kept between runs; delete `tmp/dev-homebridge` to start over. Restarting Homebridge from the UI does not work in this setup, so stop and rerun the script instead. Set `DEV_UI_PORT` to use another port than 8592.

## License

Apache-2.0. The Whisker cloud API details are based on [pylitterbot](https://github.com/natekspencer/pylitterbot) (MIT). This project is not affiliated with Whisker.
