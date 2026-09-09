# Changelog

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
