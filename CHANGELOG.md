# Changelog

## [2.2.2](https://github.com/atdr/buzz-me-in/compare/v2.2.1...v2.2.2) (2026-10-01)


### Bug Fixes

* **deps:** bump axios to 1.20.0 to clear the audit gate ([#115](https://github.com/atdr/buzz-me-in/issues/115)) ([d1afcfc](https://github.com/atdr/buzz-me-in/commit/d1afcfc6ae96b84d27c9d83e74f489e3919b5671))
* **deps:** bump dotenv from 18.0.1 to 18.0.4 ([#113](https://github.com/atdr/buzz-me-in/issues/113)) ([0929c88](https://github.com/atdr/buzz-me-in/commit/0929c88b9ad3ed88e6457b55b28b2730c16caf82))
* **deps:** bump twilio from 6.1.1 to 6.1.2 ([#114](https://github.com/atdr/buzz-me-in/issues/114)) ([67b04f5](https://github.com/atdr/buzz-me-in/commit/67b04f51fdcaab6a797224cc1785dfcdb705ef42))
* **deps:** replace websocket with ws, dropping the deprecated yaeti install warning ([da67887](https://github.com/atdr/buzz-me-in/commit/da678870541fd22151fff356aec2d36f184e0ed5))
* **server:** reject an unparseable WebSocket upgrade target with 400 instead of exiting ([da67887](https://github.com/atdr/buzz-me-in/commit/da678870541fd22151fff356aec2d36f184e0ed5))

## [2.2.1](https://github.com/atdr/buzz-me-in/compare/v2.2.0...v2.2.1) (2026-09-27)


### Bug Fixes

* **homekit:** stop the Pi → iPhone audio burst and dropouts ([#107](https://github.com/atdr/buzz-me-in/issues/107)) ([d40c11e](https://github.com/atdr/buzz-me-in/commit/d40c11eb807f35ecd5bbf9cf67b7b38a45a74a37))
* **package:** drop ./ prefix from bin path ([#104](https://github.com/atdr/buzz-me-in/issues/104)) ([f1daf64](https://github.com/atdr/buzz-me-in/commit/f1daf64962c21d794991070cb04020a992ae5003))

## [2.2.0](https://github.com/atdr/buzz-me-in/compare/v2.1.1...v2.2.0) (2026-09-27)


### Features

* **homekit:** hold the call open briefly after the live view closes ([#88](https://github.com/atdr/buzz-me-in/issues/88)) ([f25a46e](https://github.com/atdr/buzz-me-in/commit/f25a46e87e573cae492b7aa7b7d41c6afa6cadc9))
* **server:** log who called, with optional labels for known numbers ([#96](https://github.com/atdr/buzz-me-in/issues/96)) ([6b2eac8](https://github.com/atdr/buzz-me-in/commit/6b2eac8da6e999692d9d1bd6e2aa596b9a5d56f2))
* **server:** verify Twilio signature on the /media handshake ([#84](https://github.com/atdr/buzz-me-in/issues/84)) ([812a6cf](https://github.com/atdr/buzz-me-in/commit/812a6cff7fe6c08dca5422d4ce80038b89443a9d))


### Bug Fixes

* **core:** stop forwarding Twilio audio once the live view closes ([#95](https://github.com/atdr/buzz-me-in/issues/95)) ([11c1820](https://github.com/atdr/buzz-me-in/commit/11c182065af6e5cfab5948df789f1db5df15b7fb))
* **deps:** bump dotenv from 17.4.2 to 18.0.1 ([#99](https://github.com/atdr/buzz-me-in/issues/99)) ([80926b9](https://github.com/atdr/buzz-me-in/commit/80926b938f0090a5647128b0b61a201a3410fd21))
* **deps:** bump twilio from 6.1.0 to 6.1.1 ([#92](https://github.com/atdr/buzz-me-in/issues/92)) ([99d6a21](https://github.com/atdr/buzz-me-in/commit/99d6a2108ab49ef61869e246baa8db00e1d99680))
* **deps:** bump zod from 4.5.4 to 4.6.5 ([#93](https://github.com/atdr/buzz-me-in/issues/93)) ([f510171](https://github.com/atdr/buzz-me-in/commit/f5101717d62ade5f07dd7e3ae7ed9c2f22d60592))
* **homekit:** declare mono layout on the inbound audio input ([#87](https://github.com/atdr/buzz-me-in/issues/87)) ([f432af1](https://github.com/atdr/buzz-me-in/commit/f432af1fece8a7c1609617208cd9dc3fd5f76cfa))
* **homekit:** only hang up when the last HomeKit session ends ([#89](https://github.com/atdr/buzz-me-in/issues/89)) ([9773526](https://github.com/atdr/buzz-me-in/commit/9773526a2293aee1384e07b9686752fd6b75cd9e))

## [2.1.1](https://github.com/atdr/buzz-me-in/compare/v2.1.0...v2.1.1) (2026-09-09)


### Bug Fixes

* **homekit:** point the suppressed-QR log at buzz-me-in --qr ([#81](https://github.com/atdr/buzz-me-in/issues/81)) ([eef30bd](https://github.com/atdr/buzz-me-in/commit/eef30bdaf4998b53cbb7869717760d4e62332d6f))

## [2.1.0](https://github.com/atdr/buzz-me-in/compare/v2.0.1...v2.1.0) (2026-09-09)


### Features

* **cli:** add --qr, --check, --help and --version to the bin ([#79](https://github.com/atdr/buzz-me-in/issues/79)) ([ae229da](https://github.com/atdr/buzz-me-in/commit/ae229da93286173553b2ce876e0899c55a209fda))

## [2.0.1](https://github.com/atdr/buzz-me-in/compare/v2.0.0...v2.0.1) (2026-09-09)


### Bug Fixes

* **homekit:** stop erasing HomeKit pairings on every clean shutdown ([fe3d73e](https://github.com/atdr/buzz-me-in/commit/fe3d73e0a31e5219fd2dea95f65b3d12a3b75c9b))

## [2.0.0](https://github.com/atdr/buzz-me-in/compare/v1.0.1...v2.0.0) (2026-09-09)


### ⚠ BREAKING CHANGES

* **deploy:** the service now runs from a global npm install. ExecStart changes to the npm global bin and the shipped unit no longer works against a git checkout. Install with `sudo npm install -g buzz-me-in` before restarting. See README "Upgrading from a git checkout".

### Features

* **deploy:** run the service from a global npm install ([9f5459f](https://github.com/atdr/buzz-me-in/commit/9f5459fccc1856c98acab1026b1df7c0ee9fa575))
* **packaging:** publish as an unscoped npm package ([d397220](https://github.com/atdr/buzz-me-in/commit/d397220a61495a3b16ed82c9a0d9aaf1ae3b2d2b))

## [1.0.1](https://github.com/atdr/twilio-homekit-intercom/compare/v1.0.0...v1.0.1) (2026-09-03)


### Bug Fixes

* **deps:** bump qs from 6.15.2 to 6.16.0 ([#69](https://github.com/atdr/twilio-homekit-intercom/issues/69)) ([58ec60d](https://github.com/atdr/twilio-homekit-intercom/commit/58ec60daf8de482b03fba6e6993e4c41c99a305c))
* **deps:** bump twilio from 6.0.2 to 6.1.0 ([#65](https://github.com/atdr/twilio-homekit-intercom/issues/65)) ([86fa299](https://github.com/atdr/twilio-homekit-intercom/commit/86fa29987cea74177ace23b939ef63c40186f3d7))
* **deps:** bump zod from 4.4.3 to 4.5.4 ([#71](https://github.com/atdr/twilio-homekit-intercom/issues/71)) ([8c98f79](https://github.com/atdr/twilio-homekit-intercom/commit/8c98f79c464c9c5079f1204cce77335588e2095a))

## 1.0.0 (2026-07-26)


### Features

* **logging:** add lightweight structured logger and migrate runtime logs ([ee67716](https://github.com/atdr/twilio-homekit-intercom/commit/ee6771653806f6fad3561af7d37c8848f212d403))


### Bug Fixes

* bump brace-expansion and qs to patch audit advisories ([071e55a](https://github.com/atdr/twilio-homekit-intercom/commit/071e55ab6245a612bb34ba81cea85a5d1a84e2fe))
* **deps:** bump transitive form-data to 4.0.6 to resolve CRLF injection advisory ([#45](https://github.com/atdr/twilio-homekit-intercom/issues/45)) ([35d0458](https://github.com/atdr/twilio-homekit-intercom/commit/35d0458645bcc34113f2b377f9abdc4df344848b))
* exclude CHANGELOG.md from prettier checks ([#58](https://github.com/atdr/twilio-homekit-intercom/issues/58)) ([e5242d2](https://github.com/atdr/twilio-homekit-intercom/commit/e5242d2b39d49c5fb92db3025deaf36c1c3ceafa))
* harden call teardown and process lifecycle ([#30](https://github.com/atdr/twilio-homekit-intercom/issues/30)) ([5b02700](https://github.com/atdr/twilio-homekit-intercom/commit/5b027007ce17e43ec44d0a161e3407388379886c))
* harden secret handling, ws limits, and CI permissions from security review ([#47](https://github.com/atdr/twilio-homekit-intercom/issues/47)) ([8dd2cd5](https://github.com/atdr/twilio-homekit-intercom/commit/8dd2cd544f977ca3e1e9b4cd0dc268140b9caff4))
* **logging:** send serialization fallback to stderr ([e667682](https://github.com/atdr/twilio-homekit-intercom/commit/e667682cab6730a4a3b55cf637151b08b11291d7))
