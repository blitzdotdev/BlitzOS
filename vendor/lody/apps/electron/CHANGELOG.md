# Changelog

## [0.76.0](https://github.com/loro-dev/lody/compare/lody-electron-v0.75.1...lody-electron-v0.76.0) (2026-08-03)

### Bug Fixes

- **cli:** stop worker OOM restart loops [risk:medium] ([#3241](https://github.com/loro-dev/lody/issues/3241)) ([1006ef9](https://github.com/loro-dev/lody/commit/1006ef96346575cdd0786ef86690c40ba3bef23c))
- **electron:** close focused tab with Cmd+W ([#3255](https://github.com/loro-dev/lody/issues/3255)) ([7f4a611](https://github.com/loro-dev/lody/commit/7f4a611fae8d0a543ff1318d2dcc489e9d53a49c))

## [0.75.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.75.0...lody-electron-v0.75.1) (2026-08-02)

### Chores

- **lody-electron:** Synchronize lody-clients versions

## [0.75.0](https://github.com/loro-dev/lody/compare/lody-electron-v0.74.0...lody-electron-v0.75.0) (2026-08-02)

### Features

- enable Desktop email login in development
  ([#3201](https://github.com/loro-dev/lody/issues/3201))
  ([3fa695a](https://github.com/loro-dev/lody/commit/3fa695a3d9d8dc3eb114b1f2f52444e830fcaebf))
- launch underwater landing and unified site docs
  ([#2921](https://github.com/loro-dev/lody/issues/2921))
  ([92f7da2](https://github.com/loro-dev/lody/commit/92f7da2ee304292305ca628d9d87df56fc6ded78))

### Bug Fixes

- hide Windows console windows when spawning child processes
  ([#3225](https://github.com/loro-dev/lody/issues/3225))
  ([d396be1](https://github.com/loro-dev/lody/commit/d396be1a4945116cb575a699a049490321e43efb))

## [0.74.0](https://github.com/loro-dev/lody/compare/lody-electron-v0.73.0...lody-electron-v0.74.0) (2026-07-31)

### ⚠ BREAKING CHANGES

- dual-author local-first — renderer and CLI direct-author their own data
  ([#3138](https://github.com/loro-dev/lody/issues/3138))

### Features

- add native ACP session fork
  ([#3133](https://github.com/loro-dev/lody/issues/3133))
  ([c4eaec5](https://github.com/loro-dev/lody/commit/c4eaec56a0cfcafd41d5e7537237c3ffae97c45b))
- cool-white light theme and archive/diff UX polish
  ([#3136](https://github.com/loro-dev/lody/issues/3136))
  ([3b5a002](https://github.com/loro-dev/lody/commit/3b5a002d9cfc0dd8e59856d078180fa2fe4c375e))
- dual-author local-first — renderer and CLI direct-author their own data
  ([#3138](https://github.com/loro-dev/lody/issues/3138))
  ([b54d3c9](https://github.com/loro-dev/lody/commit/b54d3c9cb393b048ae3338fb0fdf488c985d7e65))
- replace session preview with browser
  ([ba84202](https://github.com/loro-dev/lody/commit/ba84202dc018e38986cab2dc2ddc6ca4efcb74c4))

### Bug Fixes

- add dev-only Desktop email password login
  ([#3141](https://github.com/loro-dev/lody/issues/3141))
  ([5ade29f](https://github.com/loro-dev/lody/commit/5ade29fd822194cbfcd0adb23c1d8d752aaab018))
- drop build-essential requirement from npx lody
  ([#3135](https://github.com/loro-dev/lody/issues/3135))
  ([dde8b83](https://github.com/loro-dev/lody/commit/dde8b835115d76a526fce2a2fa98a6a0462794a5))

## [0.73.0](https://github.com/loro-dev/lody/compare/lody-electron-v0.72.0...lody-electron-v0.73.0) (2026-07-26)

### Bug Fixes

- keep sidebar sharing stable across offline auth blips
  ([#3091](https://github.com/loro-dev/lody/issues/3091))
  ([27b363a](https://github.com/loro-dev/lody/commit/27b363ab65d52bf3ab3ce12f1269e089f204fea8))

## [0.72.0](https://github.com/loro-dev/lody/compare/lody-electron-v0.71.5...lody-electron-v0.72.0) (2026-07-25)

### Chores

- **lody-electron:** Synchronize lody-clients versions

## [0.71.5](https://github.com/loro-dev/lody/compare/lody-electron-v0.71.4...lody-electron-v0.71.5) (2026-07-24)

### Chores

- **lody-electron:** Synchronize lody-clients versions

## [0.71.4](https://github.com/loro-dev/lody/compare/lody-electron-v0.71.3...lody-electron-v0.71.4) (2026-07-23)

### Chores

- **lody-electron:** Synchronize lody-clients versions

## [0.71.3](https://github.com/loro-dev/lody/compare/lody-electron-v0.71.2...lody-electron-v0.71.3) (2026-07-23)

### Chores

- **lody-electron:** Synchronize lody-clients versions

## [0.71.2](https://github.com/loro-dev/lody/compare/lody-electron-v0.71.1...lody-electron-v0.71.2) (2026-07-22)

### Chores

- **lody-electron:** Synchronize lody-clients versions

## [0.71.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.71.0...lody-electron-v0.71.1) (2026-07-22)

### Chores

- **lody-electron:** Synchronize lody-clients versions

## [0.71.0](https://github.com/loro-dev/lody/compare/lody-electron-v0.70.1...lody-electron-v0.71.0) (2026-07-22)

### Features

- add built-in Kimi Code managed runtime
  ([#2946](https://github.com/loro-dev/lody/issues/2946))
  ([e15f831](https://github.com/loro-dev/lody/commit/e15f83197641d8eb247745810a46359343795631))
- add secure machine pairing flow
  ([#2929](https://github.com/loro-dev/lody/issues/2929))
  ([445924b](https://github.com/loro-dev/lody/commit/445924b46f4555e0e585aa8696a4891c8bacb687))
- stripe & pricing page ([#2980](https://github.com/loro-dev/lody/issues/2980))
  ([628b4ad](https://github.com/loro-dev/lody/commit/628b4addcb56c6aff590bfae96b811699e0ee616))

### Bug Fixes

- address project sharing review
  ([819f2b4](https://github.com/loro-dev/lody/commit/819f2b42c4297c6c8d970eb34ae811801f8e2e57))
- collapse macOS traffic-light insets in Electron fullscreen
  ([#2934](https://github.com/loro-dev/lody/issues/2934))
  ([c99a22c](https://github.com/loro-dev/lody/commit/c99a22c9ee667ff52beb7d5faac174e0767e3749))
- **electron:** wire account auth methods
  ([#2916](https://github.com/loro-dev/lody/issues/2916))
  ([a311383](https://github.com/loro-dev/lody/commit/a3113831434df5bf2bbb65ffad69e67830e70d79))
- fall back to VS Code deeplink
  ([#2942](https://github.com/loro-dev/lody/issues/2942))
  ([439c406](https://github.com/loro-dev/lody/commit/439c406242a8a42991019bd51405e5edc991c291))
- keep Electron watch worker in Node mode
  ([#3038](https://github.com/loro-dev/lody/issues/3038))
  ([3cbb6c2](https://github.com/loro-dev/lody/commit/3cbb6c2dbdc58df26a144e41da87e5572d530222))
- match Windows title bar to app theme with hidden titleBarOverlay
  ([#2984](https://github.com/loro-dev/lody/issues/2984))
  ([aa5a16d](https://github.com/loro-dev/lody/commit/aa5a16dd733e106d80d3b0a4acd29b06769da24d))
- preserve visibility coverage after auth recovery merge
  ([69fbe82](https://github.com/loro-dev/lody/commit/69fbe8230660031e0779650074a62cf0feaeb7ee))
- repair shared settings typecheck
  ([0d79d51](https://github.com/loro-dev/lody/commit/0d79d51c27fd37d6feb84fc63e6fd4758d9dd68c))
- sync local projects through machine flock
  ([#2976](https://github.com/loro-dev/lody/issues/2976))
  ([509528b](https://github.com/loro-dev/lody/commit/509528b29eb2942a5e86aa0a5cdbfd81b2fbcb22))

## [0.70.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.70.0...lody-electron-v0.70.1) (2026-07-17)

### Chores

- **lody-electron:** Synchronize lody-clients versions

## [0.70.0](https://github.com/loro-dev/lody/compare/lody-electron-v0.69.0...lody-electron-v0.70.0) (2026-07-16)

### Features

- sync invited workspaces in desktop
  ([#2900](https://github.com/loro-dev/lody/issues/2900))
  ([6bdb28a](https://github.com/loro-dev/lody/commit/6bdb28a70cc4d91bdccd5de3b3067d6cb7d33286))

### Bug Fixes

- **electron:** allow Lody avatar image hosts
  ([#2905](https://github.com/loro-dev/lody/issues/2905))
  ([d110ba1](https://github.com/loro-dev/lody/commit/d110ba10369edac6148e46d516857a8d101d9036))
- handle node test registration promises
  ([e0f6b6d](https://github.com/loro-dev/lody/commit/e0f6b6d92b41559d23cfb0d7e6025f96e3fec7d1))
- harden local agent host ownership
  ([#2873](https://github.com/loro-dev/lody/issues/2873))
  ([549c807](https://github.com/loro-dev/lody/commit/549c807a7e8147ad78c37845a9800695d0a1c58d))
- macOS desktop sidebar/titlebar layout polish (inset, toggle, animation)
  ([#2870](https://github.com/loro-dev/lody/issues/2870))
  ([5cd676e](https://github.com/loro-dev/lody/commit/5cd676e67853b186fbaeac11e537ea4e37994be6))
- make Electron auth callback transactional
  ([#2907](https://github.com/loro-dev/lody/issues/2907))
  ([e53a795](https://github.com/loro-dev/lody/commit/e53a795eb6f06d26e503a53f04324e611e42eb55))
- polish session interaction states
  ([6621f41](https://github.com/loro-dev/lody/commit/6621f41bdf4d007f8c586a1a53aea4c44bd40918))
- prevent Electron resize background flashes
  ([#2888](https://github.com/loro-dev/lody/issues/2888))
  ([0293de3](https://github.com/loro-dev/lody/commit/0293de36db62660f792f6a153a78d671534c5711))

## [0.57.1-next.45](https://github.com/loro-dev/lody/compare/lody-electron-v0.57.1-next.44...lody-electron-v0.57.1-next.45) (2026-07-16)

### Features

- sync invited workspaces in desktop
  ([#2900](https://github.com/loro-dev/lody/issues/2900))
  ([6bdb28a](https://github.com/loro-dev/lody/commit/6bdb28a70cc4d91bdccd5de3b3067d6cb7d33286))

### Bug Fixes

- **electron:** allow Lody avatar image hosts
  ([#2905](https://github.com/loro-dev/lody/issues/2905))
  ([d110ba1](https://github.com/loro-dev/lody/commit/d110ba10369edac6148e46d516857a8d101d9036))
- handle node test registration promises
  ([e0f6b6d](https://github.com/loro-dev/lody/commit/e0f6b6d92b41559d23cfb0d7e6025f96e3fec7d1))
- make Electron auth callback transactional
  ([#2907](https://github.com/loro-dev/lody/issues/2907))
  ([e53a795](https://github.com/loro-dev/lody/commit/e53a795eb6f06d26e503a53f04324e611e42eb55))

## [0.69.0](https://github.com/loro-dev/lody/compare/lody-electron-v0.68.1...lody-electron-v0.69.0) (2026-07-10)

### Bug Fixes

- prevent mention virtual anchor update loop
  ([#2833](https://github.com/loro-dev/lody/issues/2833))
  ([9f05676](https://github.com/loro-dev/lody/commit/9f0567639994bdf26895cdb022549258bd88cebd))

## [0.68.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.68.0...lody-electron-v0.68.1) (2026-07-08)

### Bug Fixes

- Recover Electron OAuth verifier errors
  ([#2824](https://github.com/loro-dev/lody/issues/2824))
  ([2a8f8e3](https://github.com/loro-dev/lody/commit/2a8f8e3f2749213442739f29f08ef158dfc00ee6))
- reduce ResizeObserver loop noise
  ([#2822](https://github.com/loro-dev/lody/issues/2822))
  ([91ef1d4](https://github.com/loro-dev/lody/commit/91ef1d46abceee03d51e500ea44b32c0a94a05a9))

## [0.68.0](https://github.com/loro-dev/lody/compare/lody-electron-v0.67.3...lody-electron-v0.68.0) (2026-07-07)

### Chores

- **lody-electron:** Synchronize lody-clients versions

## [0.67.3](https://github.com/loro-dev/lody/compare/lody-electron-v0.67.2...lody-electron-v0.67.3) (2026-07-07)

### Chores

- **lody-electron:** Synchronize lody-clients versions

## [0.67.2](https://github.com/loro-dev/lody/compare/lody-electron-v0.67.1...lody-electron-v0.67.2) (2026-07-07)

### Bug Fixes

- win ci
  ([aa30ac7](https://github.com/loro-dev/lody/commit/aa30ac7baf6a47128173f9ff4c5e43d7c80f60f8))

## [0.67.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.67.0...lody-electron-v0.67.1) (2026-07-07)

### Bug Fixes

- win ci
  ([5332a79](https://github.com/loro-dev/lody/commit/5332a794f25bf278caacce65987a9f4b5e8f8090))

## [0.67.0](https://github.com/loro-dev/lody/compare/lody-electron-v0.66.1...lody-electron-v0.67.0) (2026-07-07)

### Features

- track shortcut usage analytics
  ([#2781](https://github.com/loro-dev/lody/issues/2781))
  ([138ba2c](https://github.com/loro-dev/lody/commit/138ba2c7a10d677973e6795956015413b8b77fef))

### Bug Fixes

- android loro wasm init ([#2778](https://github.com/loro-dev/lody/issues/2778))
  ([0721118](https://github.com/loro-dev/lody/commit/0721118c50a69379fe2b8f1c35c06f084e067d6a))
- improve managed runtime onboarding
  ([#2788](https://github.com/loro-dev/lody/issues/2788))
  ([b1bf057](https://github.com/loro-dev/lody/commit/b1bf057f100d6733917d0d0f23b8d149114b6959))
- pass system proxy to managed runtime downloads
  ([#2797](https://github.com/loro-dev/lody/issues/2797))
  ([999e96b](https://github.com/loro-dev/lody/commit/999e96b45496aa1c8c532219d8c64aa8a28f2060))
- recover Electron deep-link login without waiting for timeout
  ([#2770](https://github.com/loro-dev/lody/issues/2770))
  ([a34aaba](https://github.com/loro-dev/lody/commit/a34aaba288c161e382eccb8b01a51654b4f5fc9c))
- report ErrorBoundary and Electron main errors to PostHog
  ([#2801](https://github.com/loro-dev/lody/issues/2801))
  ([56edfe3](https://github.com/loro-dev/lody/commit/56edfe3e8cae2017d4bf9a0dc8d9bd147ee12b9e))
- sync Electron native title bar color with in-app theme on Windows
  ([#2784](https://github.com/loro-dev/lody/issues/2784))
  ([c9ea848](https://github.com/loro-dev/lody/commit/c9ea848dff570045d7814a684b8f66ccc463090c))

## [0.57.1-next.40](https://github.com/loro-dev/lody/compare/lody-electron-v0.57.1-next.39...lody-electron-v0.57.1-next.40) (2026-07-07)

### Bug Fixes

- pass system proxy to managed runtime downloads
  ([#2797](https://github.com/loro-dev/lody/issues/2797))
  ([999e96b](https://github.com/loro-dev/lody/commit/999e96b45496aa1c8c532219d8c64aa8a28f2060))

## [0.57.1-next.39](https://github.com/loro-dev/lody/compare/lody-electron-v0.57.1-next.38...lody-electron-v0.57.1-next.39) (2026-07-07)

### Chores

- **lody-electron:** Synchronize lody-clients versions

## [0.57.1-next.38](https://github.com/loro-dev/lody/compare/lody-electron-v0.57.1-next.37...lody-electron-v0.57.1-next.38) (2026-07-07)

### Bug Fixes

- improve managed runtime onboarding
  ([#2788](https://github.com/loro-dev/lody/issues/2788))
  ([b1bf057](https://github.com/loro-dev/lody/commit/b1bf057f100d6733917d0d0f23b8d149114b6959))
- sync Electron native title bar color with in-app theme on Windows
  ([#2784](https://github.com/loro-dev/lody/issues/2784))
  ([c9ea848](https://github.com/loro-dev/lody/commit/c9ea848dff570045d7814a684b8f66ccc463090c))

## [0.57.1-next.37](https://github.com/loro-dev/lody/compare/lody-electron-v0.57.1-next.36...lody-electron-v0.57.1-next.37) (2026-07-06)

### Features

- track shortcut usage analytics
  ([#2781](https://github.com/loro-dev/lody/issues/2781))
  ([138ba2c](https://github.com/loro-dev/lody/commit/138ba2c7a10d677973e6795956015413b8b77fef))

### Bug Fixes

- android loro wasm init ([#2778](https://github.com/loro-dev/lody/issues/2778))
  ([0721118](https://github.com/loro-dev/lody/commit/0721118c50a69379fe2b8f1c35c06f084e067d6a))
- recover Electron deep-link login without waiting for timeout
  ([#2770](https://github.com/loro-dev/lody/issues/2770))
  ([a34aaba](https://github.com/loro-dev/lody/commit/a34aaba288c161e382eccb8b01a51654b4f5fc9c))

## [0.57.1-next.36](https://github.com/loro-dev/lody/compare/lody-electron-v0.57.1-next.35...lody-electron-v0.57.1-next.36) (2026-07-02)

### Chores

- **lody-electron:** Synchronize lody-clients versions

## [0.57.1-next.35](https://github.com/loro-dev/lody/compare/lody-electron-v0.57.1-next.34...lody-electron-v0.57.1-next.35) (2026-07-01)

### Features

- show Claude Code `fast` config option like Codex fast-mode
  ([#2727](https://github.com/loro-dev/lody/issues/2727))
  ([a8438bf](https://github.com/loro-dev/lody/commit/a8438bf35477b44e0ad1ff79852e837384f25bd8))

### Bug Fixes

- follow release version for iOS App Store release
  ([#2726](https://github.com/loro-dev/lody/issues/2726))
  ([a8438bf](https://github.com/loro-dev/lody/commit/a8438bf35477b44e0ad1ff79852e837384f25bd8))

## [0.66.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.66.0...lody-electron-v0.66.1) (2026-07-03)

### Chores

- **lody-electron:** Synchronize lody-clients versions

## [0.66.0](https://github.com/loro-dev/lody/compare/lody-electron-v0.65.0...lody-electron-v0.66.0) (2026-07-01)

### Chores

- **lody-electron:** Synchronize lody-clients versions

## [0.65.0](https://github.com/loro-dev/lody/compare/lody-electron-v0.64.2...lody-electron-v0.65.0) (2026-06-30)

### Features

- add embedded terminal ([#2396](https://github.com/loro-dev/lody/issues/2396))
  ([cff0f68](https://github.com/loro-dev/lody/commit/cff0f68fa58cb96071e763f21f1f80091a8ef271))
- add project file browsing for GitHub and local projects
  ([#2357](https://github.com/loro-dev/lody/issues/2357))
  ([a0a571c](https://github.com/loro-dev/lody/commit/a0a571c497124f2bde34da54079771f93b416a76))
- **components:** cross-platform command + hotkey registry
  ([#2087](https://github.com/loro-dev/lody/issues/2087))
  ([e4c110e](https://github.com/loro-dev/lody/commit/e4c110eaad2f1bc50a58a583b334dd5717b5548d))
- **electron:** add toggle to disable CLI autostart (control-only mode)
  ([#2537](https://github.com/loro-dev/lody/issues/2537))
  ([9771df7](https://github.com/loro-dev/lody/commit/9771df72a1c78d634ab7764f439bf10550e7a04f))
- **pr:** add Draft pull request status with icon and display
  ([#2541](https://github.com/loro-dev/lody/issues/2541))
  ([8d7c9ee](https://github.com/loro-dev/lody/commit/8d7c9ee02c03870a0a0c4e7ab784c0dc881de556))
- record app version in analytics and show it in web About
  ([#2480](https://github.com/loro-dev/lody/issues/2480))
  ([05a3ad4](https://github.com/loro-dev/lody/commit/05a3ad4e6ad858eb40460c62df63f691ef6d530e))
- rewrite Code Collab v2 ([#2516](https://github.com/loro-dev/lody/issues/2516))
  ([ce83943](https://github.com/loro-dev/lody/commit/ce839431dac24f7407e3d51fec93379ce349b698))
- session file attachments across web, desktop, mobile, CLI, and agents
  ([#2451](https://github.com/loro-dev/lody/issues/2451))
  ([d87c6ad](https://github.com/loro-dev/lody/commit/d87c6ad1b365651c60ee4df978e9f977d5500681))
- support image drag-and-drop anywhere in session interface
  ([#2524](https://github.com/loro-dev/lody/issues/2524))
  ([65b4f83](https://github.com/loro-dev/lody/commit/65b4f8333bbc7c175ba5a9b00419ae7401408357))

### Bug Fixes

- auth
  ([55fe36d](https://github.com/loro-dev/lody/commit/55fe36d55b0637524d967f7fb58147c82fb90bbd))
- avoid Windows Electron email input crash
  ([#2628](https://github.com/loro-dev/lody/issues/2628))
  ([1670404](https://github.com/loro-dev/lody/commit/1670404ee0a9096a49a56b1711257edc8606e3e8))
- build Windows Electron on main and upload to R2
  ([#2629](https://github.com/loro-dev/lody/issues/2629))
  ([8af4938](https://github.com/loro-dev/lody/commit/8af4938fb8d72218cef95efbd7005e1b2477c26c))
- classify electron posthog events as desktop
  ([#2605](https://github.com/loro-dev/lody/issues/2605))
  ([c1beda6](https://github.com/loro-dev/lody/commit/c1beda66baa775c1b7c4b447b9c4ad138c649139))
- **cli:** auto re-bootstrap stale CLI credentials after Electron login
  ([#2498](https://github.com/loro-dev/lody/issues/2498))
  ([4fe9325](https://github.com/loro-dev/lody/commit/4fe932592b3f2e41b6646f8305e2c7e55b8712a1))
- compute turn-diff line counts with a git-matching line diff
  ([#2602](https://github.com/loro-dev/lody/issues/2602))
  ([f208a30](https://github.com/loro-dev/lody/commit/f208a3087174adb1f559a70f5ff41ee0cca5eb3d))
- electron auth
  ([6175edf](https://github.com/loro-dev/lody/commit/6175edff1d84931becfd8ec4437dfd8c8bea5229))
- **electron:** build Code Collab workers with wasm + top-level-await plugins
  ([acc0e08](https://github.com/loro-dev/lody/commit/acc0e0889bda5624127c27f146f0984dfcbddb01))
- **electron:** reset dmg installer background
  ([#2475](https://github.com/loro-dev/lody/issues/2475))
  ([6601705](https://github.com/loro-dev/lody/commit/6601705e2c78db22fae9e6f9080ce42f1c181868))
- **electron:** ship embedded CLI runtime deps with electron-ABI sqlite binding
  ([#2442](https://github.com/loro-dev/lody/issues/2442))
  ([2d186b9](https://github.com/loro-dev/lody/commit/2d186b903971b7e0c61580a7e4b5013ecbc40379))
- **electron:** upgrade electron-builder to ^26.15.3 to unbreak DMG packaging
  ([42c6456](https://github.com/loro-dev/lody/commit/42c645644ba49a8323c9a3e1c9a832cac6aaea51))
- exit macOS fullscreen before hiding window on Cmd+W
  ([#2503](https://github.com/loro-dev/lody/issues/2503))
  ([c96e127](https://github.com/loro-dev/lody/commit/c96e127d19538d89a41ac9ed0b789876aa0caaeb))
- limit Electron main window minimum size
  ([#2581](https://github.com/loro-dev/lody/issues/2581))
  ([b8e5197](https://github.com/loro-dev/lody/commit/b8e5197ba26fbb7036160d4466021f13d884b43b))
- open editors in a new window via CLI instead of url scheme
  ([#2622](https://github.com/loro-dev/lody/issues/2622))
  ([7174b99](https://github.com/loro-dev/lody/commit/7174b990b69484a4054a40b30c298346560f5d31))
- package embedded cli node-pty
  ([#2476](https://github.com/loro-dev/lody/issues/2476))
  ([4bba3b3](https://github.com/loro-dev/lody/commit/4bba3b3ff3de0b1636fed717ee0a50b346e1ce1c))
- repair electron terminal packaging
  ([#2492](https://github.com/loro-dev/lody/issues/2492))
  ([451ed47](https://github.com/loro-dev/lody/commit/451ed47c5bd827c0d3dc131e20bca5850af06cd0))
- resolve "Open in" custom launchers with the user's shell PATH
  ([#2648](https://github.com/loro-dev/lody/issues/2648))
  ([124853f](https://github.com/loro-dev/lody/commit/124853fb511ecd3fb56259cace762b948f892ce4))
- resolve "Open in" custom launchers with the user's shell PATH
  ([#2648](https://github.com/loro-dev/lody/issues/2648))
  ([bfa01bd](https://github.com/loro-dev/lody/commit/bfa01bdf76c5f02d3ea9ca4ac984febc16f9e2a8))
- route local project setup through electron control
  ([e664610](https://github.com/loro-dev/lody/commit/e664610da01fa5009e52151e9f458b6e8f2b5005))
- seed quick-session handoff meta
  ([#2568](https://github.com/loro-dev/lody/issues/2568))
  ([c6b86e5](https://github.com/loro-dev/lody/commit/c6b86e5f3aac9d0918a85751b2e6d57c9e214cab))
- upgrade node-pty for Windows CI
  ([#2484](https://github.com/loro-dev/lody/issues/2484))
  ([b9a51b7](https://github.com/loro-dev/lody/commit/b9a51b7ca924f6d7648e6f5ad2e64f9ff3708e10))
- upgrade node-pty for Windows CI
  ([#2484](https://github.com/loro-dev/lody/issues/2484))
  ([5bff434](https://github.com/loro-dev/lody/commit/5bff434dced06f2b434e5393952b450d49007172))
- use macOS helper for embedded CLI
  ([#2619](https://github.com/loro-dev/lody/issues/2619))
  ([029db52](https://github.com/loro-dev/lody/commit/029db5225602d9f4ce896a30897fb722a68dd43f))
- use scrollbar-pro for settings skills list and turn diff panel
  ([#2613](https://github.com/loro-dev/lody/issues/2613))
  ([cfadabe](https://github.com/loro-dev/lody/commit/cfadabe81b3d872b3e646ec83041e88b2bbc68a8))
- windows
  ([8d7f473](https://github.com/loro-dev/lody/commit/8d7f4731d47732fb60baad5454d07e9549f89ea7))
- Windows -36861 renderer crash via locale .pak, then drop input workarounds
  ([#2638](https://github.com/loro-dev/lody/issues/2638))
  ([5f1dfb7](https://github.com/loro-dev/lody/commit/5f1dfb7b51ba2c73cce5d9dafc42826c4b1e6903))

## [0.63.3](https://github.com/loro-dev/lody/compare/lody-electron-v0.63.2...lody-electron-v0.63.3) (2026-06-25)

### Bug Fixes

- resolve "Open in" custom launchers with the user's shell PATH
  ([#2648](https://github.com/loro-dev/lody/issues/2648))
  ([124853f](https://github.com/loro-dev/lody/commit/124853fb511ecd3fb56259cace762b948f892ce4))
- resolve "Open in" custom launchers with the user's shell PATH
  ([#2648](https://github.com/loro-dev/lody/issues/2648))
  ([bfa01bd](https://github.com/loro-dev/lody/commit/bfa01bdf76c5f02d3ea9ca4ac984febc16f9e2a8))

## [0.63.2](https://github.com/loro-dev/lody/compare/lody-electron-v0.63.1...lody-electron-v0.63.2) (2026-06-24)

### Bug Fixes

- electron auth
  ([6175edf](https://github.com/loro-dev/lody/commit/6175edff1d84931becfd8ec4437dfd8c8bea5229))
- Windows -36861 renderer crash via locale .pak, then drop input workarounds
  ([#2638](https://github.com/loro-dev/lody/issues/2638))
  ([5f1dfb7](https://github.com/loro-dev/lody/commit/5f1dfb7b51ba2c73cce5d9dafc42826c4b1e6903))

## [0.63.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.63.0...lody-electron-v0.63.1) (2026-06-24)

### Bug Fixes

- avoid Windows Electron email input crash
  ([#2628](https://github.com/loro-dev/lody/issues/2628))
  ([1670404](https://github.com/loro-dev/lody/commit/1670404ee0a9096a49a56b1711257edc8606e3e8))
- build Windows Electron on main and upload to R2
  ([#2629](https://github.com/loro-dev/lody/issues/2629))
  ([8af4938](https://github.com/loro-dev/lody/commit/8af4938fb8d72218cef95efbd7005e1b2477c26c))
- windows
  ([8d7f473](https://github.com/loro-dev/lody/commit/8d7f4731d47732fb60baad5454d07e9549f89ea7))

## [0.63.0](https://github.com/loro-dev/lody/compare/lody-electron-v0.62.0...lody-electron-v0.63.0) (2026-06-24)

### Features

- **components:** cross-platform command + hotkey registry
  ([#2087](https://github.com/loro-dev/lody/issues/2087))
  ([e4c110e](https://github.com/loro-dev/lody/commit/e4c110eaad2f1bc50a58a583b334dd5717b5548d))
- **electron:** add toggle to disable CLI autostart (control-only mode)
  ([#2537](https://github.com/loro-dev/lody/issues/2537))
  ([9771df7](https://github.com/loro-dev/lody/commit/9771df72a1c78d634ab7764f439bf10550e7a04f))
- **pr:** add Draft pull request status with icon and display
  ([#2541](https://github.com/loro-dev/lody/issues/2541))
  ([8d7c9ee](https://github.com/loro-dev/lody/commit/8d7c9ee02c03870a0a0c4e7ab784c0dc881de556))
- rewrite Code Collab v2 ([#2516](https://github.com/loro-dev/lody/issues/2516))
  ([ce83943](https://github.com/loro-dev/lody/commit/ce839431dac24f7407e3d51fec93379ce349b698))
- session file attachments across web, desktop, mobile, CLI, and agents
  ([#2451](https://github.com/loro-dev/lody/issues/2451))
  ([d87c6ad](https://github.com/loro-dev/lody/commit/d87c6ad1b365651c60ee4df978e9f977d5500681))
- support image drag-and-drop anywhere in session interface
  ([#2524](https://github.com/loro-dev/lody/issues/2524))
  ([65b4f83](https://github.com/loro-dev/lody/commit/65b4f8333bbc7c175ba5a9b00419ae7401408357))

### Bug Fixes

- classify electron posthog events as desktop
  ([#2605](https://github.com/loro-dev/lody/issues/2605))
  ([c1beda6](https://github.com/loro-dev/lody/commit/c1beda66baa775c1b7c4b447b9c4ad138c649139))
- compute turn-diff line counts with a git-matching line diff
  ([#2602](https://github.com/loro-dev/lody/issues/2602))
  ([f208a30](https://github.com/loro-dev/lody/commit/f208a3087174adb1f559a70f5ff41ee0cca5eb3d))
- exit macOS fullscreen before hiding window on Cmd+W
  ([#2503](https://github.com/loro-dev/lody/issues/2503))
  ([c96e127](https://github.com/loro-dev/lody/commit/c96e127d19538d89a41ac9ed0b789876aa0caaeb))
- limit Electron main window minimum size
  ([#2581](https://github.com/loro-dev/lody/issues/2581))
  ([b8e5197](https://github.com/loro-dev/lody/commit/b8e5197ba26fbb7036160d4466021f13d884b43b))
- open editors in a new window via CLI instead of url scheme
  ([#2622](https://github.com/loro-dev/lody/issues/2622))
  ([7174b99](https://github.com/loro-dev/lody/commit/7174b990b69484a4054a40b30c298346560f5d31))
- seed quick-session handoff meta
  ([#2568](https://github.com/loro-dev/lody/issues/2568))
  ([c6b86e5](https://github.com/loro-dev/lody/commit/c6b86e5f3aac9d0918a85751b2e6d57c9e214cab))
- use macOS helper for embedded CLI
  ([#2619](https://github.com/loro-dev/lody/issues/2619))
  ([029db52](https://github.com/loro-dev/lody/commit/029db5225602d9f4ce896a30897fb722a68dd43f))
- use scrollbar-pro for settings skills list and turn diff panel
  ([#2613](https://github.com/loro-dev/lody/issues/2613))
  ([cfadabe](https://github.com/loro-dev/lody/commit/cfadabe81b3d872b3e646ec83041e88b2bbc68a8))

## [0.57.1-next.30](https://github.com/loro-dev/lody/compare/lody-electron-v0.57.1-next.29...lody-electron-v0.57.1-next.30) (2026-06-24)

### Bug Fixes

- classify electron posthog events as desktop
  ([#2605](https://github.com/loro-dev/lody/issues/2605))
  ([c1beda6](https://github.com/loro-dev/lody/commit/c1beda66baa775c1b7c4b447b9c4ad138c649139))
- use scrollbar-pro for settings skills list and turn diff panel
  ([#2613](https://github.com/loro-dev/lody/issues/2613))
  ([cfadabe](https://github.com/loro-dev/lody/commit/cfadabe81b3d872b3e646ec83041e88b2bbc68a8))

## [0.62.0](https://github.com/loro-dev/lody/compare/lody-electron-v0.61.0...lody-electron-v0.62.0) (2026-06-15)

### Bug Fixes

- auth
  ([55fe36d](https://github.com/loro-dev/lody/commit/55fe36d55b0637524d967f7fb58147c82fb90bbd))
- **cli:** auto re-bootstrap stale CLI credentials after Electron login
  ([#2498](https://github.com/loro-dev/lody/issues/2498))
  ([4fe9325](https://github.com/loro-dev/lody/commit/4fe932592b3f2e41b6646f8305e2c7e55b8712a1))

## [0.61.0](https://github.com/loro-dev/lody/compare/lody-electron-v0.60.1...lody-electron-v0.61.0) (2026-06-15)

### Bug Fixes

- repair electron terminal packaging
  ([#2492](https://github.com/loro-dev/lody/issues/2492))
  ([451ed47](https://github.com/loro-dev/lody/commit/451ed47c5bd827c0d3dc131e20bca5850af06cd0))

## [0.60.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.60.0...lody-electron-v0.60.1) (2026-06-14)

### Bug Fixes

- upgrade node-pty for Windows CI
  ([#2484](https://github.com/loro-dev/lody/issues/2484))
  ([b9a51b7](https://github.com/loro-dev/lody/commit/b9a51b7ca924f6d7648e6f5ad2e64f9ff3708e10))
- upgrade node-pty for Windows CI
  ([#2484](https://github.com/loro-dev/lody/issues/2484))
  ([5bff434](https://github.com/loro-dev/lody/commit/5bff434dced06f2b434e5393952b450d49007172))

## [0.60.0](https://github.com/loro-dev/lody/compare/lody-electron-v0.59.1...lody-electron-v0.60.0) (2026-06-14)

### Features

- add embedded terminal ([#2396](https://github.com/loro-dev/lody/issues/2396))
  ([cff0f68](https://github.com/loro-dev/lody/commit/cff0f68fa58cb96071e763f21f1f80091a8ef271))
- record app version in analytics and show it in web About
  ([#2480](https://github.com/loro-dev/lody/issues/2480))
  ([05a3ad4](https://github.com/loro-dev/lody/commit/05a3ad4e6ad858eb40460c62df63f691ef6d530e))

### Bug Fixes

- **electron:** reset dmg installer background
  ([#2475](https://github.com/loro-dev/lody/issues/2475))
  ([6601705](https://github.com/loro-dev/lody/commit/6601705e2c78db22fae9e6f9080ce42f1c181868))
- package embedded cli node-pty
  ([#2476](https://github.com/loro-dev/lody/issues/2476))
  ([4bba3b3](https://github.com/loro-dev/lody/commit/4bba3b3ff3de0b1636fed717ee0a50b346e1ce1c))

## [0.59.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.59.0...lody-electron-v0.59.1) (2026-06-11)

### Chores

- **electron:** ship embedded CLI runtime deps with electron-ABI sqlite binding
  ([#2442](https://github.com/loro-dev/lody/issues/2442))
  ([2d186b9](https://github.com/loro-dev/lody/commit/2d186b903971b7e0c61580a7e4b5013ecbc40379))

## [0.59.0](https://github.com/loro-dev/lody/compare/lody-electron-v0.58.1...lody-electron-v0.59.0) (2026-06-11)

### Chores

- **lody-electron:** Synchronize lody-clients versions

## [0.57.1-next.16](https://github.com/loro-dev/lody/compare/lody-electron-v0.57.1-next.15...lody-electron-v0.57.1-next.16) (2026-06-11)

### Chores

- **lody-electron:** Synchronize lody-clients versions

## [0.57.1-next.15](https://github.com/loro-dev/lody/compare/lody-electron-v0.57.1-next.14...lody-electron-v0.57.1-next.15) (2026-06-11)

### Chores

- **lody-electron:** Synchronize lody-clients versions

## [0.57.1-next.14](https://github.com/loro-dev/lody/compare/lody-electron-v0.57.1-next.13...lody-electron-v0.57.1-next.14) (2026-06-11)

### Chores

- **lody-electron:** Synchronize lody-clients versions

## [0.57.1-next.13](https://github.com/loro-dev/lody/compare/lody-electron-v0.57.1-next.12...lody-electron-v0.57.1-next.13) (2026-06-10)

### Bug Fixes

- **electron:** build Code Collab workers with wasm + top-level-await plugins
  ([acc0e08](https://github.com/loro-dev/lody/commit/acc0e0889bda5624127c27f146f0984dfcbddb01))
- **electron:** upgrade electron-builder to ^26.15.3 to unbreak DMG packaging
  ([42c6456](https://github.com/loro-dev/lody/commit/42c645644ba49a8323c9a3e1c9a832cac6aaea51))

## [0.57.1-next.12](https://github.com/loro-dev/lody/compare/lody-electron-v0.57.1-next.11...lody-electron-v0.57.1-next.12) (2026-06-10)

### Chores

- **lody-electron:** Synchronize lody-clients versions

## [0.57.1-next.11](https://github.com/loro-dev/lody/compare/lody-electron-v0.57.1-next.10...lody-electron-v0.57.1-next.11) (2026-06-09)

### Chores

- **lody-electron:** Synchronize lody-clients versions

## [0.57.1-next.10](https://github.com/loro-dev/lody/compare/lody-electron-v0.57.1-next.9...lody-electron-v0.57.1-next.10) (2026-06-08)

### Chores

- **lody-electron:** Synchronize lody-clients versions

## [0.57.1-next.9](https://github.com/loro-dev/lody/compare/lody-electron-v0.57.1-next.8...lody-electron-v0.57.1-next.9) (2026-06-07)

### Features

- add project file browsing for GitHub and local projects
  ([#2357](https://github.com/loro-dev/lody/issues/2357))
  ([a0a571c](https://github.com/loro-dev/lody/commit/a0a571c497124f2bde34da54079771f93b416a76))

## [0.57.1-next.8](https://github.com/loro-dev/lody/compare/lody-electron-v0.57.1-next.7...lody-electron-v0.57.1-next.8) (2026-06-06)

### Chores

- **lody-electron:** Synchronize lody-clients versions

## [0.57.1-next.7](https://github.com/loro-dev/lody/compare/lody-electron-v0.57.1-next.6...lody-electron-v0.57.1-next.7) (2026-06-06)

### Chores

- **lody-electron:** Synchronize lody-clients versions

## [0.57.1-next.6](https://github.com/loro-dev/lody/compare/lody-electron-v0.57.1-next.5...lody-electron-v0.57.1-next.6) (2026-06-06)

### Chores

- **lody-electron:** Synchronize lody-clients versions

## [0.57.1-next.5](https://github.com/loro-dev/lody/compare/lody-electron-v0.57.1-next.4...lody-electron-v0.57.1-next.5) (2026-06-04)

### Chores

- **lody-electron:** Synchronize lody-clients versions

## [0.57.1-next.4](https://github.com/loro-dev/lody/compare/lody-electron-v0.57.1-next.3...lody-electron-v0.57.1-next.4) (2026-06-02)

### Chores

- **lody-electron:** Synchronize lody-clients versions

## [0.57.1-next.3](https://github.com/loro-dev/lody/compare/lody-electron-v0.57.1-next.2...lody-electron-v0.57.1-next.3) (2026-06-02)

### Chores

- **lody-electron:** Synchronize lody-clients versions

## [0.57.1-next.2](https://github.com/loro-dev/lody/compare/lody-electron-v0.57.1-next.1...lody-electron-v0.57.1-next.2) (2026-06-02)

### Chores

- **lody-electron:** Synchronize lody-clients versions

## [0.57.1-next.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.57.1-next...lody-electron-v0.57.1-next.1) (2026-06-02)

### Chores

- **lody-electron:** Synchronize lody-clients versions

## [0.57.1-next](https://github.com/loro-dev/lody/compare/lody-electron-v0.57.0...lody-electron-v0.57.1-next) (2026-06-02)

### Chores

- **lody-electron:** Synchronize lody-clients versions

## [0.57.3](https://github.com/loro-dev/lody/compare/lody-electron-v0.57.2...lody-electron-v0.57.3) (2026-06-03)

### Chores

- **lody-electron:** Synchronize lody-clients versions

## [0.57.2](https://github.com/loro-dev/lody/compare/lody-electron-v0.57.1...lody-electron-v0.57.2) (2026-06-03)

### Chores

- **lody-electron:** Synchronize lody-clients versions

## [0.57.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.57.0...lody-electron-v0.57.1) (2026-06-03)

### Chores

- **lody-electron:** Synchronize lody-clients versions

## [0.57.0](https://github.com/loro-dev/lody/compare/lody-electron-v0.56.0...lody-electron-v0.57.0) (2026-06-02)

### Bug Fixes

- **electron:** remove oversized Windows taskbar overlay badge
  ([#2288](https://github.com/loro-dev/lody/issues/2288))
  ([0a904fd](https://github.com/loro-dev/lody/commit/0a904fdf382065d3ab89353eee1efd02b231810d))
- stabilize electron session recovery
  ([#2289](https://github.com/loro-dev/lody/issues/2289))
  ([bc7bb07](https://github.com/loro-dev/lody/commit/bc7bb07f3b12638f1b4e2bf4abe1f955f3a6dd76))

## [0.56.0](https://github.com/loro-dev/lody/compare/lody-electron-v0.55.2...lody-electron-v0.56.0) (2026-06-01)

### Features

- **acp:** support binary-distribution registry agents
  ([#2274](https://github.com/loro-dev/lody/issues/2274))
  ([3d11d91](https://github.com/loro-dev/lody/commit/3d11d9177a9a06d0bcdcdd16c2748398d7dcb87e))
- **analytics:** PostHog instrumentation foundation + all P0 events
  ([#2261](https://github.com/loro-dev/lody/issues/2261))
  ([73bd935](https://github.com/loro-dev/lody/commit/73bd935b783cc7b66c537d3f99d0c7faf5676122))

### Bug Fixes

- **acp-history-sync:** add conflict recovery requirements & plan
  ([#2276](https://github.com/loro-dev/lody/issues/2276))
  ([117120a](https://github.com/loro-dev/lody/commit/117120a18bd107449293419ab050b48ed44afc37))
- **electron:** avoid shared root imports in desktop build
  ([#2281](https://github.com/loro-dev/lody/issues/2281))
  ([8cc3e10](https://github.com/loro-dev/lody/commit/8cc3e10d5173fe1f050d4c1e24629eee3efed113))

## [0.55.2](https://github.com/loro-dev/lody/compare/lody-electron-v0.55.1...lody-electron-v0.55.2) (2026-05-29)

### Bug Fixes

- **build:** emit [@fontsource](https://github.com/fontsource) fonts via
  @tailwindcss/vite plugin
  ([#2249](https://github.com/loro-dev/lody/issues/2249))
  ([e92007b](https://github.com/loro-dev/lody/commit/e92007bdf6afee6a138a2f50dd2f4ab511e02a11))
- inject login-shell PATH when spawning ACP agents
  ([#2243](https://github.com/loro-dev/lody/issues/2243))
  ([41f6cde](https://github.com/loro-dev/lody/commit/41f6cdeee3bd2568bf61862d103a219abb2be439))

## [0.55.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.55.0...lody-electron-v0.55.1) (2026-05-28)

### Chores

- **lody-electron:** Synchronize lody-cli-electron versions

## [0.55.0](https://github.com/loro-dev/lody/compare/lody-electron-v0.54.1...lody-electron-v0.55.0) (2026-05-28)

### Features

- new mobile ui
  ([27a54f3](https://github.com/loro-dev/lody/commit/27a54f35b77d1e9ae72bb65d057d1c3e1d301c66))

### Bug Fixes

- **electron:** recover from renderer fatal errors with visible UI
  ([#2233](https://github.com/loro-dev/lody/issues/2233))
  ([73233a9](https://github.com/loro-dev/lody/commit/73233a95b456110c6eda0c28f66bee5b664e5cdd))

## [0.54.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.54.0...lody-electron-v0.54.1) (2026-05-28)

### Bug Fixes

- improve mermaid rendering in desktop and dark mode
  ([#2227](https://github.com/loro-dev/lody/issues/2227))
  ([48724fb](https://github.com/loro-dev/lody/commit/48724fb9cb08a70a2734edb9884a281d2dd71409))

## [0.54.0](https://github.com/loro-dev/lody/compare/lody-electron-v0.53.0...lody-electron-v0.54.0) (2026-05-26)

### Features

- allow renaming workspace in settings
  ([#2209](https://github.com/loro-dev/lody/issues/2209))
  ([c36154d](https://github.com/loro-dev/lody/commit/c36154dcf06a995198b8d8b4810ae047d569c684))
- release 2026-0527
  ([382cac2](https://github.com/loro-dev/lody/commit/382cac215c58a1e14178f8a0f80a35cfc90c5096))

### Bug Fixes

- prevent desktop and mobile startup white screens
  ([#2201](https://github.com/loro-dev/lody/issues/2201))
  ([c87c2b5](https://github.com/loro-dev/lody/commit/c87c2b5ee623f8028e3b7d5998cb267d29948d8d))

## [0.53.0](https://github.com/loro-dev/lody/compare/lody-electron-v0.52.3...lody-electron-v0.53.0) (2026-05-20)

### Features

- Add Streamdown markdown rendering
  ([#2179](https://github.com/loro-dev/lody/issues/2179))
  ([c4b59ce](https://github.com/loro-dev/lody/commit/c4b59cead662546cbd03d1c1f04422460a2c779b))
- release 2026-0520
  ([82a9e79](https://github.com/loro-dev/lody/commit/82a9e7937111336073d703387f5f37b5114fd56c))

## [0.52.3](https://github.com/loro-dev/lody/compare/lody-electron-v0.52.2...lody-electron-v0.52.3) (2026-05-17)

### Bug Fixes

- remove web local health probe
  ([#2152](https://github.com/loro-dev/lody/issues/2152))
  ([009c017](https://github.com/loro-dev/lody/commit/009c0171c6a54c1b99eb7c3262591042b673934c))

## [0.52.2](https://github.com/loro-dev/lody/compare/lody-electron-v0.52.1...lody-electron-v0.52.2) (2026-05-17)

### Chores

- **lody-electron:** Synchronize lody-cli-electron versions

## [0.52.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.52.0...lody-electron-v0.52.1) (2026-05-16)

### Chores

- **lody-electron:** Synchronize lody-cli-electron versions

## [0.52.0](https://github.com/loro-dev/lody/compare/lody-electron-v0.51.0...lody-electron-v0.52.0) (2026-05-16)

### Chores

- **lody-electron:** Synchronize lody-cli-electron versions

## [0.51.0](https://github.com/loro-dev/lody/compare/lody-electron-v0.50.2...lody-electron-v0.51.0) (2026-05-15)

### Features

- claude sync
  ([428bb64](https://github.com/loro-dev/lody/commit/428bb6452c2330f0910049c7c95ffbb1397a88ba))
- Codex/Claude Code local project history sync
  ([#2119](https://github.com/loro-dev/lody/issues/2119))
  ([428bb64](https://github.com/loro-dev/lody/commit/428bb6452c2330f0910049c7c95ffbb1397a88ba))

## [0.50.2](https://github.com/loro-dev/lody/compare/lody-electron-v0.50.1...lody-electron-v0.50.2) (2026-05-13)

### Chores

- **lody-electron:** Synchronize lody-cli-electron versions

## [0.50.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.50.0...lody-electron-v0.50.1) (2026-05-09)

### Bug Fixes

- **onboarding:** re-bootstrap CLI when desktop session userId mismatches
  ([#2083](https://github.com/loro-dev/lody/issues/2083))
  ([d81cb60](https://github.com/loro-dev/lody/commit/d81cb6015edfae78582b9f25fcb16f9564c4ede6))

## [0.50.0](https://github.com/loro-dev/lody/compare/lody-electron-v0.49.1...lody-electron-v0.50.0) (2026-05-09)

### Features

- release 2026-0509
  ([7ba810d](https://github.com/loro-dev/lody/commit/7ba810dad2f44325915d36650076bc30d017f2bf))

### Bug Fixes

- **components:** disable text selection in left sidebar
  ([#2065](https://github.com/loro-dev/lody/issues/2065))
  ([c2a5e63](https://github.com/loro-dev/lody/commit/c2a5e63e1277016ffd9cb66f4f07a5e826c7b7ca))
- quote electron cli command display
  ([#2062](https://github.com/loro-dev/lody/issues/2062))
  ([2b7769b](https://github.com/loro-dev/lody/commit/2b7769bab8368e22e0b18dc096af7d0627d8d9ad))
- wire electron cancel invitation bridge
  ([#2069](https://github.com/loro-dev/lody/issues/2069))
  ([6909690](https://github.com/loro-dev/lody/commit/69096905a99c83092788053aac811ef28a2462f5))

### Documentation

- add local project worktree design
  ([#2070](https://github.com/loro-dev/lody/issues/2070))
  ([793915e](https://github.com/loro-dev/lody/commit/793915eae089a6d7798f59856c42ec582dfc4885))

## [0.49.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.49.0...lody-electron-v0.49.1) (2026-05-07)

### Chores

- **lody-electron:** Synchronize lody-cli-electron versions

## [0.49.0](https://github.com/loro-dev/lody/compare/lody-electron-v0.48.0...lody-electron-v0.49.0) (2026-05-07)

### Features

- release 260507
  ([3709913](https://github.com/loro-dev/lody/commit/370991344148b47d99d180142c2f95b85f679883))
- tab status — unread favicon (web) + dock badge (electron)
  ([#1963](https://github.com/loro-dev/lody/issues/1963))
  ([b148915](https://github.com/loro-dev/lody/commit/b1489158f2114f4a8b03d59d4068297c2f1ea027))

## [0.48.0](https://github.com/loro-dev/lody/compare/lody-electron-v0.47.1...lody-electron-v0.48.0) (2026-04-28)

### Bug Fixes

- mobile white screen
  ([59590ec](https://github.com/loro-dev/lody/commit/59590ec4dbdcccbb573656d223a25d97fe00a35e))

## [0.47.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.47.0...lody-electron-v0.47.1) (2026-04-27)

### Chores

- **lody-electron:** Synchronize lody-cli-electron versions

## [0.48.0](https://github.com/loro-dev/lody/compare/lody-electron-v0.47.1...lody-electron-v0.48.0) (2026-04-28)

### Bug Fixes

- mobile white screen
  ([59590ec](https://github.com/loro-dev/lody/commit/59590ec4dbdcccbb573656d223a25d97fe00a35e))

## [0.47.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.47.0...lody-electron-v0.47.1) (2026-04-27)

### Chores

- **lody-electron:** Synchronize lody-cli-electron versions

## [0.47.0](https://github.com/loro-dev/lody/compare/lody-electron-v0.46.0...lody-electron-v0.47.0) (2026-04-27)

### Bug Fixes

- constrain electron cli output footer
  ([#1907](https://github.com/loro-dev/lody/issues/1907))
  ([d1b8d5f](https://github.com/loro-dev/lody/commit/d1b8d5f90f7cb149c410b941c67a268e4a839c2f))

## [0.46.0](https://github.com/loro-dev/lody/compare/lody-electron-v0.45.1...lody-electron-v0.46.0) (2026-04-24)

### Features

- **shared:** cache Loro Streams JWT token in localStorage
  ([#1898](https://github.com/loro-dev/lody/issues/1898))
  ([d543b7c](https://github.com/loro-dev/lody/commit/d543b7ca06c62a1460bdc66c84f6b347c828e09c))

## [0.46.1-next.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.46.0-next.1...lody-electron-v0.46.1-next.1) (2026-04-24)

### Features

- add non-interactive CLI auth
  ([#1770](https://github.com/loro-dev/lody/issues/1770))
  ([e27afa5](https://github.com/loro-dev/lody/commit/e27afa59704708e9deffd58cbbb5a0a00c11b57b))
- **cli:** add daemon mode and extract cli-supervisor package
  ([#1568](https://github.com/loro-dev/lody/issues/1568))
  ([d45af11](https://github.com/loro-dev/lody/commit/d45af11722e57b486d30a1b02829829f98343d20))
- **components:** add session pin for context recall
  ([#1530](https://github.com/loro-dev/lody/issues/1530))
  ([e207266](https://github.com/loro-dev/lody/commit/e2072661783849b1541cac39716771d12767878c))
- electron prevent sleep badge
  ([#1636](https://github.com/loro-dev/lody/issues/1636))
  ([9db7742](https://github.com/loro-dev/lody/commit/9db7742952e743d30f5f9742d24d3358c07203dd))
- release 2026-03-24 ([#1455](https://github.com/loro-dev/lody/issues/1455))
  ([80b6f82](https://github.com/loro-dev/lody/commit/80b6f828fd539b70874acb4cbb5b946f718651df))
- release 260422 ([#1879](https://github.com/loro-dev/lody/issues/1879))
  ([150961f](https://github.com/loro-dev/lody/commit/150961f36329fca28168b2861590d2faed6dae25))
- **shared:** cache Loro Streams JWT token in localStorage
  ([#1898](https://github.com/loro-dev/lody/issues/1898))
  ([d543b7c](https://github.com/loro-dev/lody/commit/d543b7ca06c62a1460bdc66c84f6b347c828e09c))
- support title generation for all ACP agents
  ([#1440](https://github.com/loro-dev/lody/issues/1440))
  ([9211184](https://github.com/loro-dev/lody/commit/92111846a41579d37efd669fd14050ca702657d9))
- unify file/diff viewer tabs into session tab bar
  ([#1470](https://github.com/loro-dev/lody/issues/1470))
  ([adcb217](https://github.com/loro-dev/lody/commit/adcb21797b58bf043a8b91bccf47ac8232ffdcf9))

### Bug Fixes

- acp unsupport config option
  ([#1426](https://github.com/loro-dev/lody/issues/1426))
  ([96a0695](https://github.com/loro-dev/lody/commit/96a06956950b9dcb17e34fd1fb5065cea49d95ee))
- **cli:** diagnostic logging for stream_not_found room join errors
  ([#1553](https://github.com/loro-dev/lody/issues/1553))
  ([b22b9c0](https://github.com/loro-dev/lody/commit/b22b9c04ee05b5ee32c3139c067bfc50188a1650))
- **components:** add branch info to mobile session more menu
  ([#1529](https://github.com/loro-dev/lody/issues/1529))
  ([0c7bca7](https://github.com/loro-dev/lody/commit/0c7bca7ba07290e47e3a80035acf30707c95c653))
- **components:** sync pending invitations on workspace switch and add cancel
  ([#1820](https://github.com/loro-dev/lody/issues/1820))
  ([0905a29](https://github.com/loro-dev/lody/commit/0905a294e2f4a01935ee8a0aa16653d6b3e1318c))
- display specific ACP error reasons in chat failure notices
  ([80b6f82](https://github.com/loro-dev/lody/commit/80b6f828fd539b70874acb4cbb5b946f718651df))
- **electron:** auto-detect Linux keyring backend for safeStorage
  ([#1431](https://github.com/loro-dev/lody/issues/1431))
  ([88304fb](https://github.com/loro-dev/lody/commit/88304fb77dfbad842e5a0c1888d22b3b308a9a56))
- eliminate session chat layout shift with CSS container queries
  ([#1698](https://github.com/loro-dev/lody/issues/1698))
  ([b793143](https://github.com/loro-dev/lody/commit/b79314341ec2f32759422f35925fe8d5645ed696))
- open GitHub install externally in desktop
  ([#1769](https://github.com/loro-dev/lody/issues/1769))
  ([b918203](https://github.com/loro-dev/lody/commit/b918203893b8811d5bbdd1322612bd6a4464b249))
- prevent electron relogin workspace 404
  ([#1760](https://github.com/loro-dev/lody/issues/1760))
  ([fddf0d8](https://github.com/loro-dev/lody/commit/fddf0d875a1adcf5eca773d6a1bd78698bcc8465))
- repair packaged electron cli startup
  ([#1727](https://github.com/loro-dev/lody/issues/1727))
  ([a8fc91c](https://github.com/loro-dev/lody/commit/a8fc91cfd5f5a39d4d96d5b26a5085729110d902))
- show meaningful error when @ mention file listing fails
  ([#1489](https://github.com/loro-dev/lody/issues/1489))
  ([9344afe](https://github.com/loro-dev/lody/commit/9344afefcf2494e41bc50eabffdee90167461bc3))

## [0.45.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.45.0...lody-electron-v0.45.1) (2026-04-22)

### Chores

- **lody-electron:** Synchronize lody-cli-electron versions

## [0.45.0](https://github.com/loro-dev/lody/compare/lody-electron-v0.44.0...lody-electron-v0.45.0) (2026-04-22)

### Features

- release 260422 ([#1879](https://github.com/loro-dev/lody/issues/1879))
  ([150961f](https://github.com/loro-dev/lody/commit/150961f36329fca28168b2861590d2faed6dae25))

### Bug Fixes

- **components:** sync pending invitations on workspace switch and add cancel
  ([#1820](https://github.com/loro-dev/lody/issues/1820))
  ([0905a29](https://github.com/loro-dev/lody/commit/0905a294e2f4a01935ee8a0aa16653d6b3e1318c))

## [0.44.2-next.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.44.1-next.1...lody-electron-v0.44.2-next.1) (2026-04-22)

### Chores

- **lody-electron:** Synchronize lody-cli-electron versions

## [0.44.1-next.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.44.0-next.1...lody-electron-v0.44.1-next.1) (2026-04-19)

### Features

- add non-interactive CLI auth
  ([#1770](https://github.com/loro-dev/lody/issues/1770))
  ([e27afa5](https://github.com/loro-dev/lody/commit/e27afa59704708e9deffd58cbbb5a0a00c11b57b))
- **cli:** add daemon mode and extract cli-supervisor package
  ([#1568](https://github.com/loro-dev/lody/issues/1568))
  ([d45af11](https://github.com/loro-dev/lody/commit/d45af11722e57b486d30a1b02829829f98343d20))
- **components:** add session pin for context recall
  ([#1530](https://github.com/loro-dev/lody/issues/1530))
  ([e207266](https://github.com/loro-dev/lody/commit/e2072661783849b1541cac39716771d12767878c))
- electron prevent sleep badge
  ([#1636](https://github.com/loro-dev/lody/issues/1636))
  ([9db7742](https://github.com/loro-dev/lody/commit/9db7742952e743d30f5f9742d24d3358c07203dd))
- implement Electron application menu bar
  ([#1365](https://github.com/loro-dev/lody/issues/1365))
  ([cb72197](https://github.com/loro-dev/lody/commit/cb721978e67960d859c6bc62d5b508ee882efcf1))
- prevent system sleep while sessions are running
  ([#1357](https://github.com/loro-dev/lody/issues/1357))
  ([2c87b9d](https://github.com/loro-dev/lody/commit/2c87b9d8758bd995295df84b20ff10904614251d))
- release 2026-03-18 ([#1389](https://github.com/loro-dev/lody/issues/1389))
  ([0aec1e5](https://github.com/loro-dev/lody/commit/0aec1e5de84886bc1d935243fdca5f9fbd5829a3))
- release 2026-03-19
  ([8796e6e](https://github.com/loro-dev/lody/commit/8796e6e17cfa8b6ffc90986598b46c059d97ac09))
- release 2026-03-24 ([#1455](https://github.com/loro-dev/lody/issues/1455))
  ([80b6f82](https://github.com/loro-dev/lody/commit/80b6f828fd539b70874acb4cbb5b946f718651df))
- release 2026-0317 ([#1372](https://github.com/loro-dev/lody/issues/1372))
  ([d3d7812](https://github.com/loro-dev/lody/commit/d3d7812d577271cb8636306b2dbd7dc1788d0340))
- support title generation for all ACP agents
  ([#1440](https://github.com/loro-dev/lody/issues/1440))
  ([9211184](https://github.com/loro-dev/lody/commit/92111846a41579d37efd669fd14050ca702657d9))
- unify file/diff viewer tabs into session tab bar
  ([#1470](https://github.com/loro-dev/lody/issues/1470))
  ([adcb217](https://github.com/loro-dev/lody/commit/adcb21797b58bf043a8b91bccf47ac8232ffdcf9))

### Bug Fixes

- acp unsupport config option
  ([#1426](https://github.com/loro-dev/lody/issues/1426))
  ([96a0695](https://github.com/loro-dev/lody/commit/96a06956950b9dcb17e34fd1fb5065cea49d95ee))
- author
  ([bca55a6](https://github.com/loro-dev/lody/commit/bca55a657097910b60d0a59cf567c8afead70be6))
- auto updater
  ([1857794](https://github.com/loro-dev/lody/commit/1857794c5fb1597a9ebe87d063f50eb5f65aa3da))
- chatmode compat ([#1375](https://github.com/loro-dev/lody/issues/1375))
  ([e513888](https://github.com/loro-dev/lody/commit/e513888b597e5df4507dd8feceff7bbe164e49f8))
- cli trigger
  ([020a422](https://github.com/loro-dev/lody/commit/020a4225fcac8006c4223bb1bc8febccbdd7248b))
- **cli:** diagnostic logging for stream_not_found room join errors
  ([#1553](https://github.com/loro-dev/lody/issues/1553))
  ([b22b9c0](https://github.com/loro-dev/lody/commit/b22b9c04ee05b5ee32c3139c067bfc50188a1650))
- **components:** add branch info to mobile session more menu
  ([#1529](https://github.com/loro-dev/lody/issues/1529))
  ([0c7bca7](https://github.com/loro-dev/lody/commit/0c7bca7ba07290e47e3a80035acf30707c95c653))
- **components:** sync pending invitations on workspace switch and add cancel
  ([#1820](https://github.com/loro-dev/lody/issues/1820))
  ([0905a29](https://github.com/loro-dev/lody/commit/0905a294e2f4a01935ee8a0aa16653d6b3e1318c))
- display specific ACP error reasons in chat failure notices
  ([80b6f82](https://github.com/loro-dev/lody/commit/80b6f828fd539b70874acb4cbb5b946f718651df))
- electron auto updater
  ([3f4702d](https://github.com/loro-dev/lody/commit/3f4702d8fb8d5ea5a1182ffcacb178141832f5b9))
- **electron:** auto-detect Linux keyring backend for safeStorage
  ([#1431](https://github.com/loro-dev/lody/issues/1431))
  ([88304fb](https://github.com/loro-dev/lody/commit/88304fb77dfbad842e5a0c1888d22b3b308a9a56))
- **electron:** avoid windows email input white screen
  ([#1410](https://github.com/loro-dev/lody/issues/1410))
  ([ca4b287](https://github.com/loro-dev/lody/commit/ca4b287cc51ccc954234cc3f4aa4be21d2111731))
- eliminate session chat layout shift with CSS container queries
  ([#1698](https://github.com/loro-dev/lody/issues/1698))
  ([b793143](https://github.com/loro-dev/lody/commit/b79314341ec2f32759422f35925fe8d5645ed696))
- handle electron login route in packaged app
  ([#1387](https://github.com/loro-dev/lody/issues/1387))
  ([3559d4e](https://github.com/loro-dev/lody/commit/3559d4e834fe29e880d77c3b44a03fd2cef06755))
- open GitHub install externally in desktop
  ([#1769](https://github.com/loro-dev/lody/issues/1769))
  ([b918203](https://github.com/loro-dev/lody/commit/b918203893b8811d5bbdd1322612bd6a4464b249))
- prevent electron relogin workspace 404
  ([#1760](https://github.com/loro-dev/lody/issues/1760))
  ([fddf0d8](https://github.com/loro-dev/lody/commit/fddf0d875a1adcf5eca773d6a1bd78698bcc8465))
- remove redundant --cli-types injection from Electron CLI launcher
  ([#1405](https://github.com/loro-dev/lody/issues/1405))
  ([a789382](https://github.com/loro-dev/lody/commit/a78938211bf860d303145855254ff72090fbccdd))
- repair packaged electron cli startup
  ([#1727](https://github.com/loro-dev/lody/issues/1727))
  ([a8fc91c](https://github.com/loro-dev/lody/commit/a8fc91cfd5f5a39d4d96d5b26a5085729110d902))
- set NSUserNotificationAlertStyle to banner for macOS notifications
  ([#1356](https://github.com/loro-dev/lody/issues/1356))
  ([41653ef](https://github.com/loro-dev/lody/commit/41653efe215a56cf263b3d027cc274c2f691a483))
- show meaningful error when @ mention file listing fails
  ([#1489](https://github.com/loro-dev/lody/issues/1489))
  ([9344afe](https://github.com/loro-dev/lody/commit/9344afefcf2494e41bc50eabffdee90167461bc3))

## [0.41.18-next.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.41.17-next.1...lody-electron-v0.41.18-next.1) (2026-04-15)

### Chores

- **lody-electron:** Synchronize lody-cli-electron versions

## [0.41.17-next.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.41.16-next.1...lody-electron-v0.41.17-next.1) (2026-04-15)

### Chores

- **lody-electron:** Synchronize lody-cli-electron versions

## [0.41.16-next.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.41.15-next.1...lody-electron-v0.41.16-next.1) (2026-04-15)

### Chores

- **lody-electron:** Synchronize lody-cli-electron versions

## [0.41.15-next.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.41.14-next.1...lody-electron-v0.41.15-next.1) (2026-04-15)

### Bug Fixes

- open GitHub install externally in desktop
  ([#1769](https://github.com/loro-dev/lody/issues/1769))
  ([b918203](https://github.com/loro-dev/lody/commit/b918203893b8811d5bbdd1322612bd6a4464b249))
- prevent electron relogin workspace 404
  ([#1760](https://github.com/loro-dev/lody/issues/1760))
  ([fddf0d8](https://github.com/loro-dev/lody/commit/fddf0d875a1adcf5eca773d6a1bd78698bcc8465))

## [0.42.0](https://github.com/loro-dev/lody/compare/lody-electron-v0.41.1...lody-electron-v0.42.0) (2026-04-13)

### Features

- **cli:** add daemon mode and extract cli-supervisor package
  ([#1568](https://github.com/loro-dev/lody/issues/1568))
  ([d45af11](https://github.com/loro-dev/lody/commit/d45af11722e57b486d30a1b02829829f98343d20))
- **components:** add session pin for context recall
  ([#1530](https://github.com/loro-dev/lody/issues/1530))
  ([e207266](https://github.com/loro-dev/lody/commit/e2072661783849b1541cac39716771d12767878c))
- electron prevent sleep badge
  ([#1636](https://github.com/loro-dev/lody/issues/1636))
  ([9db7742](https://github.com/loro-dev/lody/commit/9db7742952e743d30f5f9742d24d3358c07203dd))
- unify file/diff viewer tabs into session tab bar
  ([#1470](https://github.com/loro-dev/lody/issues/1470))
  ([adcb217](https://github.com/loro-dev/lody/commit/adcb21797b58bf043a8b91bccf47ac8232ffdcf9))

### Bug Fixes

- **cli:** diagnostic logging for stream_not_found room join errors
  ([#1553](https://github.com/loro-dev/lody/issues/1553))
  ([b22b9c0](https://github.com/loro-dev/lody/commit/b22b9c04ee05b5ee32c3139c067bfc50188a1650))
- **components:** add branch info to mobile session more menu
  ([#1529](https://github.com/loro-dev/lody/issues/1529))
  ([0c7bca7](https://github.com/loro-dev/lody/commit/0c7bca7ba07290e47e3a80035acf30707c95c653))
- eliminate session chat layout shift with CSS container queries
  ([#1698](https://github.com/loro-dev/lody/issues/1698))
  ([b793143](https://github.com/loro-dev/lody/commit/b79314341ec2f32759422f35925fe8d5645ed696))
- repair packaged electron cli startup
  ([#1727](https://github.com/loro-dev/lody/issues/1727))
  ([a8fc91c](https://github.com/loro-dev/lody/commit/a8fc91cfd5f5a39d4d96d5b26a5085729110d902))
- show meaningful error when @ mention file listing fails
  ([#1489](https://github.com/loro-dev/lody/issues/1489))
  ([9344afe](https://github.com/loro-dev/lody/commit/9344afefcf2494e41bc50eabffdee90167461bc3))

## [0.41.14-next.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.41.13-next.1...lody-electron-v0.41.14-next.1) (2026-04-13)

### Chores

- **lody-electron:** Synchronize lody-cli-electron versions

## [0.41.13-next.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.41.12-next.1...lody-electron-v0.41.13-next.1) (2026-04-13)

### Bug Fixes

- repair packaged electron cli startup
  ([#1727](https://github.com/loro-dev/lody/issues/1727))
  ([a8fc91c](https://github.com/loro-dev/lody/commit/a8fc91cfd5f5a39d4d96d5b26a5085729110d902))

## [0.41.12-next.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.41.11-next.1...lody-electron-v0.41.12-next.1) (2026-04-13)

### Bug Fixes

- eliminate session chat layout shift with CSS container queries
  ([#1698](https://github.com/loro-dev/lody/issues/1698))
  ([b793143](https://github.com/loro-dev/lody/commit/b79314341ec2f32759422f35925fe8d5645ed696))

## [0.41.11-next.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.41.10-next.1...lody-electron-v0.41.11-next.1) (2026-04-12)

### Features

- electron prevent sleep badge
  ([#1636](https://github.com/loro-dev/lody/issues/1636))
  ([9db7742](https://github.com/loro-dev/lody/commit/9db7742952e743d30f5f9742d24d3358c07203dd))

## [0.41.10-next.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.41.9-next.1...lody-electron-v0.41.10-next.1) (2026-04-01)

### Features

- **cli:** add daemon mode and extract cli-supervisor package
  ([#1568](https://github.com/loro-dev/lody/issues/1568))
  ([d45af11](https://github.com/loro-dev/lody/commit/d45af11722e57b486d30a1b02829829f98343d20))
- **components:** add session pin for context recall
  ([#1530](https://github.com/loro-dev/lody/issues/1530))
  ([e207266](https://github.com/loro-dev/lody/commit/e2072661783849b1541cac39716771d12767878c))

### Bug Fixes

- **cli:** diagnostic logging for stream_not_found room join errors
  ([#1553](https://github.com/loro-dev/lody/issues/1553))
  ([b22b9c0](https://github.com/loro-dev/lody/commit/b22b9c04ee05b5ee32c3139c067bfc50188a1650))

## [0.41.9-next.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.41.8-next.1...lody-electron-v0.41.9-next.1) (2026-03-29)

### Bug Fixes

- **components:** add branch info to mobile session more menu
  ([#1529](https://github.com/loro-dev/lody/issues/1529))
  ([0c7bca7](https://github.com/loro-dev/lody/commit/0c7bca7ba07290e47e3a80035acf30707c95c653))

## [0.41.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.41.0...lody-electron-v0.41.1) (2026-03-25)

### Chores

- **lody-electron:** Synchronize lody-cli-electron versions

## [0.41.7-next.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.41.6-next.1...lody-electron-v0.41.7-next.1) (2026-03-27)

### Bug Fixes

- show meaningful error when @ mention file listing fails
  ([#1489](https://github.com/loro-dev/lody/issues/1489))
  ([9344afe](https://github.com/loro-dev/lody/commit/9344afefcf2494e41bc50eabffdee90167461bc3))

## [0.41.6-next.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.41.5-next.1...lody-electron-v0.41.6-next.1) (2026-03-26)

### Chores

- **lody-electron:** Synchronize lody-cli-electron versions

## [0.41.5-next.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.41.4-next.1...lody-electron-v0.41.5-next.1) (2026-03-26)

### Features

- unify file/diff viewer tabs into session tab bar
  ([#1470](https://github.com/loro-dev/lody/issues/1470))
  ([adcb217](https://github.com/loro-dev/lody/commit/adcb21797b58bf043a8b91bccf47ac8232ffdcf9))

## [0.41.4-next.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.41.3-next.1...lody-electron-v0.41.4-next.1) (2026-03-25)

### Chores

- **lody-electron:** Synchronize lody-cli-electron versions

## [0.41.3-next.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.41.2-next.1...lody-electron-v0.41.3-next.1) (2026-03-25)

### Chores

- **lody-electron:** Synchronize lody-cli-electron versions

## [0.41.2-next.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.41.1-next.1...lody-electron-v0.41.2-next.1) (2026-03-25)

### Chores

- **lody-electron:** Synchronize lody-cli-electron versions

## [0.41.1-next.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.41.0-next.1...lody-electron-v0.41.1-next.1) (2026-03-25)

### Features

- add branch-aware session startup
  ([#1102](https://github.com/loro-dev/lody/issues/1102))
  ([bac1b50](https://github.com/loro-dev/lody/commit/bac1b5076ac3678f997427dff472691ebd003585))
- add built-in opencode ACP support
  ([#1221](https://github.com/loro-dev/lody/issues/1221))
  ([4e8b644](https://github.com/loro-dev/lody/commit/4e8b6447d9264f20e0ff354cc1bd0bedaddc6c60))
- add electron CLI runtime state channel and sidebar status
  ([#1210](https://github.com/loro-dev/lody/issues/1210))
  ([071cbaa](https://github.com/loro-dev/lody/commit/071cbaa26af4113a7f2f62d20b8c6a2af2abfbaa))
- add electron local-first session control path
  ([#1169](https://github.com/loro-dev/lody/issues/1169))
  ([41d5e96](https://github.com/loro-dev/lody/commit/41d5e961bcb0d9258326da7c0cb2c362a2ffcddb))
- add multi-select mode to archive session view
  ([#1014](https://github.com/loro-dev/lody/issues/1014))
  ([3b03cfe](https://github.com/loro-dev/lody/commit/3b03cfefd5521820c4cee89fb97b6c3156baf088))
- **auth:** user-scoped CLI token + multi-workspace support
  ([#1048](https://github.com/loro-dev/lody/issues/1048))
  ([1da6f20](https://github.com/loro-dev/lody/commit/1da6f20dd6c2e25116da0973814b59a1c77dfc9d))
- basic electron ([#1015](https://github.com/loro-dev/lody/issues/1015))
  ([3019fc9](https://github.com/loro-dev/lody/commit/3019fc91ced6e8cbe1f03124bb10e6238e9a1bb4))
- bootstrap Electron CLI auth from session token
  ([#1148](https://github.com/loro-dev/lody/issues/1148))
  ([77b2bfa](https://github.com/loro-dev/lody/commit/77b2bfaf7bdef4d107bfc900773769c5ff2664ec))
- chat mentions ([#1028](https://github.com/loro-dev/lody/issues/1028))
  ([62d53c6](https://github.com/loro-dev/lody/commit/62d53c6845cd94aa8c491557b04a315ac9219a1c))
- **cli:** load environment variables based on runtime environment
  ([758d310](https://github.com/loro-dev/lody/commit/758d310e01d6ab93bccddcaee5bccfb4fdb15010))
- electron deeplink Auth ([#1142](https://github.com/loro-dev/lody/issues/1142))
  ([36bb712](https://github.com/loro-dev/lody/commit/36bb712df401988280fcd8e908a41f20acb46f3a))
- electron start cli ([#1047](https://github.com/loro-dev/lody/issues/1047))
  ([aed10db](https://github.com/loro-dev/lody/commit/aed10dbd8f25f7d6d9935483b48cbd03257822f2))
- **electron:** add auto-update flow with R2 release pipeline
  ([#1178](https://github.com/loro-dev/lody/issues/1178))
  ([3f5a48f](https://github.com/loro-dev/lody/commit/3f5a48f92827f5cfb053fcc441a3f63e064a85ba))
- **electron:** add desktop notification toggle with system settings guidance
  ([#1110](https://github.com/loro-dev/lody/issues/1110))
  ([293dc74](https://github.com/loro-dev/lody/commit/293dc74d555d83cda4640c5e37e03350d5613ecd))
- **electron:** close button hides window and restore from dock
  ([#1122](https://github.com/loro-dev/lody/issues/1122))
  ([965f160](https://github.com/loro-dev/lody/commit/965f160c63f8dc07283e717c5d90f2560d3cecda))
- **electron:** hide title bar on macOS and offset sidebar for traffic lights
  ([#1018](https://github.com/loro-dev/lody/issues/1018))
  ([5e67e82](https://github.com/loro-dev/lody/commit/5e67e82a2a57dc11d0b947a558727786e2d1fea2))
- **electron:** local projects
  ([#1060](https://github.com/loro-dev/lody/issues/1060))
  ([166bffe](https://github.com/loro-dev/lody/commit/166bffe8ec03758a82c7a8e49c9ab423b6c5f239))
- enable GitHub capabilities for linked local projects
  ([#1170](https://github.com/loro-dev/lody/issues/1170))
  ([a9b5d87](https://github.com/loro-dev/lody/commit/a9b5d87b71c3894037e2f2e8767155bcaab980d0))
- implement Electron application menu bar
  ([#1365](https://github.com/loro-dev/lody/issues/1365))
  ([cb72197](https://github.com/loro-dev/lody/commit/cb721978e67960d859c6bc62d5b508ee882efcf1))
- move local project implementation to CLI daemon
  ([#1192](https://github.com/loro-dev/lody/issues/1192))
  ([508b8c0](https://github.com/loro-dev/lody/commit/508b8c0adb0a5d2fb9b6ab3fd71343e3708ab6b7))
- optimize workspace usage delta retention and compaction
  ([#1253](https://github.com/loro-dev/lody/issues/1253))
  ([c1113de](https://github.com/loro-dev/lody/commit/c1113ded2bd0e5f61d3c66c239975aa50a4c8502))
- prevent system sleep while sessions are running
  ([#1357](https://github.com/loro-dev/lody/issues/1357))
  ([2c87b9d](https://github.com/loro-dev/lody/commit/2c87b9d8758bd995295df84b20ff10904614251d))
- release 2026-02-06
  ([3872d71](https://github.com/loro-dev/lody/commit/3872d7117283eb3b10ff4553e005604ee0a037b2))
- release 2026-03-18 ([#1389](https://github.com/loro-dev/lody/issues/1389))
  ([0aec1e5](https://github.com/loro-dev/lody/commit/0aec1e5de84886bc1d935243fdca5f9fbd5829a3))
- release 2026-03-19
  ([8796e6e](https://github.com/loro-dev/lody/commit/8796e6e17cfa8b6ffc90986598b46c059d97ac09))
- release 2026-03-24 ([#1455](https://github.com/loro-dev/lody/issues/1455))
  ([80b6f82](https://github.com/loro-dev/lody/commit/80b6f828fd539b70874acb4cbb5b946f718651df))
- release 2026-0312 ([#1331](https://github.com/loro-dev/lody/issues/1331))
  ([9a90d61](https://github.com/loro-dev/lody/commit/9a90d612bb5b405e3f5072f377b8615667ee65d3))
- release 2026-0317 ([#1372](https://github.com/loro-dev/lody/issues/1372))
  ([d3d7812](https://github.com/loro-dev/lody/commit/d3d7812d577271cb8636306b2dbd7dc1788d0340))
- remove local project path mapping and persist absolute paths
  ([#1240](https://github.com/loro-dev/lody/issues/1240))
  ([5c991f8](https://github.com/loro-dev/lody/commit/5c991f89b2a8d7d46eba7c4f84e1edd70ea0b92b))
- reuse local optimizations for in-action github worktrees
  ([#1128](https://github.com/loro-dev/lody/issues/1128))
  ([5f9b459](https://github.com/loro-dev/lody/commit/5f9b459abee13488b04e369149571a519d4498fe))
- show counts for collapsed sidebar groups
  ([9a90d61](https://github.com/loro-dev/lody/commit/9a90d612bb5b405e3f5072f377b8615667ee65d3))
- support title generation for all ACP agents
  ([#1440](https://github.com/loro-dev/lody/issues/1440))
  ([9211184](https://github.com/loro-dev/lody/commit/92111846a41579d37efd669fd14050ca702657d9))

### Bug Fixes

- fix:
  ([5e927bb](https://github.com/loro-dev/lody/commit/5e927bba911c528d202cfa2812a0f1e26ccb7c01))
- fix:
  ([43600a7](https://github.com/loro-dev/lody/commit/43600a76f7cea2effe212f6a60f3a4ce47390db5))
- acp unsupport config option
  ([#1426](https://github.com/loro-dev/lody/issues/1426))
  ([96a0695](https://github.com/loro-dev/lody/commit/96a06956950b9dcb17e34fd1fb5065cea49d95ee))
- allow github avatar images in electron CSP
  ([#1103](https://github.com/loro-dev/lody/issues/1103))
  ([699d401](https://github.com/loro-dev/lody/commit/699d401185eda8483d3ac683f71b8217c93a8766))
- author
  ([bca55a6](https://github.com/loro-dev/lody/commit/bca55a657097910b60d0a59cf567c8afead70be6))
- auto updater
  ([1857794](https://github.com/loro-dev/lody/commit/1857794c5fb1597a9ebe87d063f50eb5f65aa3da))
- chatmode compat ([#1375](https://github.com/loro-dev/lody/issues/1375))
  ([e513888](https://github.com/loro-dev/lody/commit/e513888b597e5df4507dd8feceff7bbe164e49f8))
- ci ([#1202](https://github.com/loro-dev/lody/issues/1202))
  ([5c107b8](https://github.com/loro-dev/lody/commit/5c107b8cb78af6b23517150ceb0cbeeb720fc2d2))
- ci build ([#1199](https://github.com/loro-dev/lody/issues/1199))
  ([1074ad3](https://github.com/loro-dev/lody/commit/1074ad32867cc27e23c48ba9f050f4031926cc1d))
- ci only mac ([#1204](https://github.com/loro-dev/lody/issues/1204))
  ([3eb581a](https://github.com/loro-dev/lody/commit/3eb581a6842be747c5c69ae3dc58c7bc013bd64d))
- **ci:** inject electron convex deploy url for packaged builds
  ([#1183](https://github.com/loro-dev/lody/issues/1183))
  ([db696a4](https://github.com/loro-dev/lody/commit/db696a4543a2b751a0bca526c561048e80b6bf91))
- cli trigger
  ([020a422](https://github.com/loro-dev/lody/commit/020a4225fcac8006c4223bb1bc8febccbdd7248b))
- csc name
  ([9a90d61](https://github.com/loro-dev/lody/commit/9a90d612bb5b405e3f5072f377b8615667ee65d3))
- csc name
  ([3e1535c](https://github.com/loro-dev/lody/commit/3e1535c9146529be1bc2dcb07f9a6fccd3af9089))
- display specific ACP error reasons in chat failure notices
  ([80b6f82](https://github.com/loro-dev/lody/commit/80b6f828fd539b70874acb4cbb5b946f718651df))
- do deploy
  ([a01fcba](https://github.com/loro-dev/lody/commit/a01fcba1e3c582cb79533aa1e2e62301df335807))
- electron auto updater
  ([3f4702d](https://github.com/loro-dev/lody/commit/3f4702d8fb8d5ea5a1182ffcacb178141832f5b9))
- electron ci
  ([6884d33](https://github.com/loro-dev/lody/commit/6884d332b6b1733cca8ba1261dcfad02eb4c9094))
- electron ci
  ([0efe2fd](https://github.com/loro-dev/lody/commit/0efe2fd7787ce563c5b2d3091de89a287d9b2d62))
- **electron:** add Windows tray menu and DevTools entry
  ([#1232](https://github.com/loro-dev/lody/issues/1232))
  ([ad3235c](https://github.com/loro-dev/lody/commit/ad3235caf7501ddb43328e3bd76dbadd978996fd))
- **electron:** allow agentclientprotocol CDN in image CSP
  ([be39ffb](https://github.com/loro-dev/lody/commit/be39ffb0090a448f8186d08ebbf1b7104b649416))
- **electron:** allow agentclientprotocol cdn in img-src csp
  ([8f9e525](https://github.com/loro-dev/lody/commit/8f9e5251e88d4db370fa94e99dc17aac859d5b39))
- **electron:** auto-detect Linux keyring backend for safeStorage
  ([#1431](https://github.com/loro-dev/lody/issues/1431))
  ([88304fb](https://github.com/loro-dev/lody/commit/88304fb77dfbad842e5a0c1888d22b3b308a9a56))
- **electron:** avoid windows email input white screen
  ([#1410](https://github.com/loro-dev/lody/issues/1410))
  ([ca4b287](https://github.com/loro-dev/lody/commit/ca4b287cc51ccc954234cc3f4aa4be21d2111731))
- **electron:** fix local project worker module resolution after packaging
  ([#1144](https://github.com/loro-dev/lody/issues/1144))
  ([2899c76](https://github.com/loro-dev/lody/commit/2899c76ff3f04e709982a60238d241085fef2f6a))
- **electron:** normalize convex site url for ci auth
  ([#1185](https://github.com/loro-dev/lody/issues/1185))
  ([e3e93bd](https://github.com/loro-dev/lody/commit/e3e93bd10a35f9daea9fc9ba4c631d6c63426c03))
- **electron:** prevent Windows file input crash and add image picker IPC
  fallback ([#1234](https://github.com/loro-dev/lody/issues/1234))
  ([ac623fd](https://github.com/loro-dev/lody/commit/ac623fd112a421c08b8688eca01ae85e4a598337))
- enable macos signing for electron releases
  ([#1321](https://github.com/loro-dev/lody/issues/1321))
  ([ad004e9](https://github.com/loro-dev/lody/commit/ad004e98ed20fa695ec2da032c84bfd5ec11e2b8))
- ensure electron update restart quits app reliably
  ([#1229](https://github.com/loro-dev/lody/issues/1229))
  ([640c354](https://github.com/loro-dev/lody/commit/640c3546760953577fdb9fb253001be7baf57cb8))
- handle electron login route in packaged app
  ([#1387](https://github.com/loro-dev/lody/issues/1387))
  ([3559d4e](https://github.com/loro-dev/lody/commit/3559d4e834fe29e880d77c3b44a03fd2cef06755))
- handle Electron refresh under file:// routes
  ([#1187](https://github.com/loro-dev/lody/issues/1187))
  ([211671f](https://github.com/loro-dev/lody/commit/211671f06bb5cad5f5d483a06869376bc7e33ef7))
- linux electron build
  ([aa08f79](https://github.com/loro-dev/lody/commit/aa08f7968aee8a408c2c3b8ef1eab2f76f414539))
- persist Electron window bounds
  ([#1304](https://github.com/loro-dev/lody/issues/1304))
  ([ccf9af4](https://github.com/loro-dev/lody/commit/ccf9af4bbedf70715b6ffe13518ea15b82d105ee))
- preserve plan expand/collapse state across virtual scroll unmount
  ([#1261](https://github.com/loro-dev/lody/issues/1261))
  ([c78146d](https://github.com/loro-dev/lody/commit/c78146d53127658ccd348a60e630586c5ca5845f))
- reduce electron drag area height to avoid blocking buttons
  ([#1109](https://github.com/loro-dev/lody/issues/1109))
  ([6625b93](https://github.com/loro-dev/lody/commit/6625b93d151ad8c9d4932871f3e95699dea57f0f))
- remove non-git local project import notice
  ([#1337](https://github.com/loro-dev/lody/issues/1337))
  ([03f2e5a](https://github.com/loro-dev/lody/commit/03f2e5a3d5172696d18ab39121ff86f5028dd8ce))
- remove redundant --cli-types injection from Electron CLI launcher
  ([#1405](https://github.com/loro-dev/lody/issues/1405))
  ([a789382](https://github.com/loro-dev/lody/commit/a78938211bf860d303145855254ff72090fbccdd))
- set NSUserNotificationAlertStyle to banner for macOS notifications
  ([#1356](https://github.com/loro-dev/lody/issues/1356))
  ([41653ef](https://github.com/loro-dev/lody/commit/41653efe215a56cf263b3d027cc274c2f691a483))
- unify electron app name as Lody
  ([#1318](https://github.com/loro-dev/lody/issues/1318))
  ([e704bbd](https://github.com/loro-dev/lody/commit/e704bbdfa2354ee9d5d5c85fb47edad18cf34556))
- use betterAuthClient for AuthClient auth validation
  ([#1161](https://github.com/loro-dev/lody/issues/1161))
  ([a83097a](https://github.com/loro-dev/lody/commit/a83097a61777ee5bf797cda1a7c527fa5ddce54b))
- windows deeplink callback and spawn shell options
  ([#1224](https://github.com/loro-dev/lody/issues/1224))
  ([22b03e8](https://github.com/loro-dev/lody/commit/22b03e831912bc4cfe12b72ed2eff045dd507902))
- windows electron
  ([2afa6a0](https://github.com/loro-dev/lody/commit/2afa6a0ef40d707cd66dfa0e6eb5eb48edf9b9db))
- windows electron
  ([e728487](https://github.com/loro-dev/lody/commit/e728487690e4254918e2e97ba07b8f17b39a486e))

### Refactors

- **electron:** modularize main entry and share IPC types
  ([#1115](https://github.com/loro-dev/lody/issues/1115))
  ([4eaf1b8](https://github.com/loro-dev/lody/commit/4eaf1b83fa30b279b599d8757a1829254373572c))
- remove remote git operations from local project flow to prevent timeout
  ([#1108](https://github.com/loro-dev/lody/issues/1108))
  ([c6a5370](https://github.com/loro-dev/lody/commit/c6a5370954e7ebca4916828d9f6c6edd3a3be13a))
- **settings:** split settings tabs and unify section headers
  ([#1242](https://github.com/loro-dev/lody/issues/1242))
  ([4ec87f1](https://github.com/loro-dev/lody/commit/4ec87f18c249c369a6619d78aaa2fc892050c445))
- support local project file mentions in electron
  ([#1101](https://github.com/loro-dev/lody/issues/1101))
  ([f9e4bc0](https://github.com/loro-dev/lody/commit/f9e4bc027d3ea4f4687dbf839939fbf779452041))

## [0.41.0](https://github.com/loro-dev/lody/compare/lody-electron-v0.40.0...lody-electron-v0.41.0) (2026-03-24)

### Features

- release 2026-03-24 ([#1455](https://github.com/loro-dev/lody/issues/1455))
  ([80b6f82](https://github.com/loro-dev/lody/commit/80b6f828fd539b70874acb4cbb5b946f718651df))
- support title generation for all ACP agents
  ([#1440](https://github.com/loro-dev/lody/issues/1440))
  ([9211184](https://github.com/loro-dev/lody/commit/92111846a41579d37efd669fd14050ca702657d9))

### Bug Fixes

- display specific ACP error reasons in chat failure notices
  ([80b6f82](https://github.com/loro-dev/lody/commit/80b6f828fd539b70874acb4cbb5b946f718651df))
- **electron:** auto-detect Linux keyring backend for safeStorage
  ([#1431](https://github.com/loro-dev/lody/issues/1431))
  ([88304fb](https://github.com/loro-dev/lody/commit/88304fb77dfbad842e5a0c1888d22b3b308a9a56))

## [0.40.0](https://github.com/loro-dev/lody/compare/lody-electron-v0.39.0...lody-electron-v0.40.0) (2026-03-21)

### Bug Fixes

- acp unsupport config option
  ([#1426](https://github.com/loro-dev/lody/issues/1426))
  ([96a0695](https://github.com/loro-dev/lody/commit/96a06956950b9dcb17e34fd1fb5065cea49d95ee))

## [0.40.2-next.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.40.1-next.1...lody-electron-v0.40.2-next.1) (2026-03-21)

### Chores

- **lody-electron:** Synchronize lody-cli-electron versions

## [0.40.4-next.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.40.3-next.1...lody-electron-v0.40.4-next.1) (2026-03-23)

### Features

- support title generation for all ACP agents
  ([#1440](https://github.com/loro-dev/lody/issues/1440))
  ([9211184](https://github.com/loro-dev/lody/commit/92111846a41579d37efd669fd14050ca702657d9))

## [0.40.3-next.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.40.2-next.1...lody-electron-v0.40.3-next.1) (2026-03-22)

### Bug Fixes

- **electron:** auto-detect Linux keyring backend for safeStorage
  ([#1431](https://github.com/loro-dev/lody/issues/1431))
  ([88304fb](https://github.com/loro-dev/lody/commit/88304fb77dfbad842e5a0c1888d22b3b308a9a56))

## [0.40.2-next.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.40.1-next.1...lody-electron-v0.40.2-next.1) (2026-03-21)

### Chores

- **lody-electron:** Synchronize lody-cli-electron versions

## [0.40.1-next.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.40.0-next.1...lody-electron-v0.40.1-next.1) (2026-03-20)

### Features

- add branch-aware session startup
  ([#1102](https://github.com/loro-dev/lody/issues/1102))
  ([bac1b50](https://github.com/loro-dev/lody/commit/bac1b5076ac3678f997427dff472691ebd003585))
- add built-in opencode ACP support
  ([#1221](https://github.com/loro-dev/lody/issues/1221))
  ([4e8b644](https://github.com/loro-dev/lody/commit/4e8b6447d9264f20e0ff354cc1bd0bedaddc6c60))
- add electron CLI runtime state channel and sidebar status
  ([#1210](https://github.com/loro-dev/lody/issues/1210))
  ([071cbaa](https://github.com/loro-dev/lody/commit/071cbaa26af4113a7f2f62d20b8c6a2af2abfbaa))
- add electron local-first session control path
  ([#1169](https://github.com/loro-dev/lody/issues/1169))
  ([41d5e96](https://github.com/loro-dev/lody/commit/41d5e961bcb0d9258326da7c0cb2c362a2ffcddb))
- add multi-select mode to archive session view
  ([#1014](https://github.com/loro-dev/lody/issues/1014))
  ([3b03cfe](https://github.com/loro-dev/lody/commit/3b03cfefd5521820c4cee89fb97b6c3156baf088))
- **auth:** user-scoped CLI token + multi-workspace support
  ([#1048](https://github.com/loro-dev/lody/issues/1048))
  ([1da6f20](https://github.com/loro-dev/lody/commit/1da6f20dd6c2e25116da0973814b59a1c77dfc9d))
- basic electron ([#1015](https://github.com/loro-dev/lody/issues/1015))
  ([3019fc9](https://github.com/loro-dev/lody/commit/3019fc91ced6e8cbe1f03124bb10e6238e9a1bb4))
- bootstrap Electron CLI auth from session token
  ([#1148](https://github.com/loro-dev/lody/issues/1148))
  ([77b2bfa](https://github.com/loro-dev/lody/commit/77b2bfaf7bdef4d107bfc900773769c5ff2664ec))
- chat mentions ([#1028](https://github.com/loro-dev/lody/issues/1028))
  ([62d53c6](https://github.com/loro-dev/lody/commit/62d53c6845cd94aa8c491557b04a315ac9219a1c))
- **cli:** load environment variables based on runtime environment
  ([758d310](https://github.com/loro-dev/lody/commit/758d310e01d6ab93bccddcaee5bccfb4fdb15010))
- electron deeplink Auth ([#1142](https://github.com/loro-dev/lody/issues/1142))
  ([36bb712](https://github.com/loro-dev/lody/commit/36bb712df401988280fcd8e908a41f20acb46f3a))
- electron start cli ([#1047](https://github.com/loro-dev/lody/issues/1047))
  ([aed10db](https://github.com/loro-dev/lody/commit/aed10dbd8f25f7d6d9935483b48cbd03257822f2))
- **electron:** add auto-update flow with R2 release pipeline
  ([#1178](https://github.com/loro-dev/lody/issues/1178))
  ([3f5a48f](https://github.com/loro-dev/lody/commit/3f5a48f92827f5cfb053fcc441a3f63e064a85ba))
- **electron:** add desktop notification toggle with system settings guidance
  ([#1110](https://github.com/loro-dev/lody/issues/1110))
  ([293dc74](https://github.com/loro-dev/lody/commit/293dc74d555d83cda4640c5e37e03350d5613ecd))
- **electron:** close button hides window and restore from dock
  ([#1122](https://github.com/loro-dev/lody/issues/1122))
  ([965f160](https://github.com/loro-dev/lody/commit/965f160c63f8dc07283e717c5d90f2560d3cecda))
- **electron:** hide title bar on macOS and offset sidebar for traffic lights
  ([#1018](https://github.com/loro-dev/lody/issues/1018))
  ([5e67e82](https://github.com/loro-dev/lody/commit/5e67e82a2a57dc11d0b947a558727786e2d1fea2))
- **electron:** local projects
  ([#1060](https://github.com/loro-dev/lody/issues/1060))
  ([166bffe](https://github.com/loro-dev/lody/commit/166bffe8ec03758a82c7a8e49c9ab423b6c5f239))
- enable GitHub capabilities for linked local projects
  ([#1170](https://github.com/loro-dev/lody/issues/1170))
  ([a9b5d87](https://github.com/loro-dev/lody/commit/a9b5d87b71c3894037e2f2e8767155bcaab980d0))
- implement Electron application menu bar
  ([#1365](https://github.com/loro-dev/lody/issues/1365))
  ([cb72197](https://github.com/loro-dev/lody/commit/cb721978e67960d859c6bc62d5b508ee882efcf1))
- move local project implementation to CLI daemon
  ([#1192](https://github.com/loro-dev/lody/issues/1192))
  ([508b8c0](https://github.com/loro-dev/lody/commit/508b8c0adb0a5d2fb9b6ab3fd71343e3708ab6b7))
- optimize workspace usage delta retention and compaction
  ([#1253](https://github.com/loro-dev/lody/issues/1253))
  ([c1113de](https://github.com/loro-dev/lody/commit/c1113ded2bd0e5f61d3c66c239975aa50a4c8502))
- prevent system sleep while sessions are running
  ([#1357](https://github.com/loro-dev/lody/issues/1357))
  ([2c87b9d](https://github.com/loro-dev/lody/commit/2c87b9d8758bd995295df84b20ff10904614251d))
- release 2026-02-06
  ([3872d71](https://github.com/loro-dev/lody/commit/3872d7117283eb3b10ff4553e005604ee0a037b2))
- release 2026-03-18 ([#1389](https://github.com/loro-dev/lody/issues/1389))
  ([0aec1e5](https://github.com/loro-dev/lody/commit/0aec1e5de84886bc1d935243fdca5f9fbd5829a3))
- release 2026-03-19
  ([8796e6e](https://github.com/loro-dev/lody/commit/8796e6e17cfa8b6ffc90986598b46c059d97ac09))
- release 2026-0312 ([#1331](https://github.com/loro-dev/lody/issues/1331))
  ([9a90d61](https://github.com/loro-dev/lody/commit/9a90d612bb5b405e3f5072f377b8615667ee65d3))
- release 2026-0317 ([#1372](https://github.com/loro-dev/lody/issues/1372))
  ([d3d7812](https://github.com/loro-dev/lody/commit/d3d7812d577271cb8636306b2dbd7dc1788d0340))
- remove local project path mapping and persist absolute paths
  ([#1240](https://github.com/loro-dev/lody/issues/1240))
  ([5c991f8](https://github.com/loro-dev/lody/commit/5c991f89b2a8d7d46eba7c4f84e1edd70ea0b92b))
- reuse local optimizations for in-action github worktrees
  ([#1128](https://github.com/loro-dev/lody/issues/1128))
  ([5f9b459](https://github.com/loro-dev/lody/commit/5f9b459abee13488b04e369149571a519d4498fe))
- show counts for collapsed sidebar groups
  ([9a90d61](https://github.com/loro-dev/lody/commit/9a90d612bb5b405e3f5072f377b8615667ee65d3))

### Bug Fixes

- fix:
  ([5e927bb](https://github.com/loro-dev/lody/commit/5e927bba911c528d202cfa2812a0f1e26ccb7c01))
- fix:
  ([43600a7](https://github.com/loro-dev/lody/commit/43600a76f7cea2effe212f6a60f3a4ce47390db5))
- allow github avatar images in electron CSP
  ([#1103](https://github.com/loro-dev/lody/issues/1103))
  ([699d401](https://github.com/loro-dev/lody/commit/699d401185eda8483d3ac683f71b8217c93a8766))
- author
  ([bca55a6](https://github.com/loro-dev/lody/commit/bca55a657097910b60d0a59cf567c8afead70be6))
- auto updater
  ([1857794](https://github.com/loro-dev/lody/commit/1857794c5fb1597a9ebe87d063f50eb5f65aa3da))
- chatmode compat ([#1375](https://github.com/loro-dev/lody/issues/1375))
  ([e513888](https://github.com/loro-dev/lody/commit/e513888b597e5df4507dd8feceff7bbe164e49f8))
- ci ([#1202](https://github.com/loro-dev/lody/issues/1202))
  ([5c107b8](https://github.com/loro-dev/lody/commit/5c107b8cb78af6b23517150ceb0cbeeb720fc2d2))
- ci build ([#1199](https://github.com/loro-dev/lody/issues/1199))
  ([1074ad3](https://github.com/loro-dev/lody/commit/1074ad32867cc27e23c48ba9f050f4031926cc1d))
- ci only mac ([#1204](https://github.com/loro-dev/lody/issues/1204))
  ([3eb581a](https://github.com/loro-dev/lody/commit/3eb581a6842be747c5c69ae3dc58c7bc013bd64d))
- **ci:** inject electron convex deploy url for packaged builds
  ([#1183](https://github.com/loro-dev/lody/issues/1183))
  ([db696a4](https://github.com/loro-dev/lody/commit/db696a4543a2b751a0bca526c561048e80b6bf91))
- cli trigger
  ([020a422](https://github.com/loro-dev/lody/commit/020a4225fcac8006c4223bb1bc8febccbdd7248b))
- csc name
  ([9a90d61](https://github.com/loro-dev/lody/commit/9a90d612bb5b405e3f5072f377b8615667ee65d3))
- csc name
  ([3e1535c](https://github.com/loro-dev/lody/commit/3e1535c9146529be1bc2dcb07f9a6fccd3af9089))
- do deploy
  ([a01fcba](https://github.com/loro-dev/lody/commit/a01fcba1e3c582cb79533aa1e2e62301df335807))
- electron auto updater
  ([3f4702d](https://github.com/loro-dev/lody/commit/3f4702d8fb8d5ea5a1182ffcacb178141832f5b9))
- electron ci
  ([6884d33](https://github.com/loro-dev/lody/commit/6884d332b6b1733cca8ba1261dcfad02eb4c9094))
- electron ci
  ([0efe2fd](https://github.com/loro-dev/lody/commit/0efe2fd7787ce563c5b2d3091de89a287d9b2d62))
- **electron:** add Windows tray menu and DevTools entry
  ([#1232](https://github.com/loro-dev/lody/issues/1232))
  ([ad3235c](https://github.com/loro-dev/lody/commit/ad3235caf7501ddb43328e3bd76dbadd978996fd))
- **electron:** allow agentclientprotocol CDN in image CSP
  ([be39ffb](https://github.com/loro-dev/lody/commit/be39ffb0090a448f8186d08ebbf1b7104b649416))
- **electron:** allow agentclientprotocol cdn in img-src csp
  ([8f9e525](https://github.com/loro-dev/lody/commit/8f9e5251e88d4db370fa94e99dc17aac859d5b39))
- **electron:** avoid windows email input white screen
  ([#1410](https://github.com/loro-dev/lody/issues/1410))
  ([ca4b287](https://github.com/loro-dev/lody/commit/ca4b287cc51ccc954234cc3f4aa4be21d2111731))
- **electron:** fix local project worker module resolution after packaging
  ([#1144](https://github.com/loro-dev/lody/issues/1144))
  ([2899c76](https://github.com/loro-dev/lody/commit/2899c76ff3f04e709982a60238d241085fef2f6a))
- **electron:** normalize convex site url for ci auth
  ([#1185](https://github.com/loro-dev/lody/issues/1185))
  ([e3e93bd](https://github.com/loro-dev/lody/commit/e3e93bd10a35f9daea9fc9ba4c631d6c63426c03))
- **electron:** prevent Windows file input crash and add image picker IPC
  fallback ([#1234](https://github.com/loro-dev/lody/issues/1234))
  ([ac623fd](https://github.com/loro-dev/lody/commit/ac623fd112a421c08b8688eca01ae85e4a598337))
- enable macos signing for electron releases
  ([#1321](https://github.com/loro-dev/lody/issues/1321))
  ([ad004e9](https://github.com/loro-dev/lody/commit/ad004e98ed20fa695ec2da032c84bfd5ec11e2b8))
- ensure electron update restart quits app reliably
  ([#1229](https://github.com/loro-dev/lody/issues/1229))
  ([640c354](https://github.com/loro-dev/lody/commit/640c3546760953577fdb9fb253001be7baf57cb8))
- handle electron login route in packaged app
  ([#1387](https://github.com/loro-dev/lody/issues/1387))
  ([3559d4e](https://github.com/loro-dev/lody/commit/3559d4e834fe29e880d77c3b44a03fd2cef06755))
- handle Electron refresh under file:// routes
  ([#1187](https://github.com/loro-dev/lody/issues/1187))
  ([211671f](https://github.com/loro-dev/lody/commit/211671f06bb5cad5f5d483a06869376bc7e33ef7))
- linux electron build
  ([aa08f79](https://github.com/loro-dev/lody/commit/aa08f7968aee8a408c2c3b8ef1eab2f76f414539))
- persist Electron window bounds
  ([#1304](https://github.com/loro-dev/lody/issues/1304))
  ([ccf9af4](https://github.com/loro-dev/lody/commit/ccf9af4bbedf70715b6ffe13518ea15b82d105ee))
- preserve plan expand/collapse state across virtual scroll unmount
  ([#1261](https://github.com/loro-dev/lody/issues/1261))
  ([c78146d](https://github.com/loro-dev/lody/commit/c78146d53127658ccd348a60e630586c5ca5845f))
- reduce electron drag area height to avoid blocking buttons
  ([#1109](https://github.com/loro-dev/lody/issues/1109))
  ([6625b93](https://github.com/loro-dev/lody/commit/6625b93d151ad8c9d4932871f3e95699dea57f0f))
- remove non-git local project import notice
  ([#1337](https://github.com/loro-dev/lody/issues/1337))
  ([03f2e5a](https://github.com/loro-dev/lody/commit/03f2e5a3d5172696d18ab39121ff86f5028dd8ce))
- remove redundant --cli-types injection from Electron CLI launcher
  ([#1405](https://github.com/loro-dev/lody/issues/1405))
  ([a789382](https://github.com/loro-dev/lody/commit/a78938211bf860d303145855254ff72090fbccdd))
- set NSUserNotificationAlertStyle to banner for macOS notifications
  ([#1356](https://github.com/loro-dev/lody/issues/1356))
  ([41653ef](https://github.com/loro-dev/lody/commit/41653efe215a56cf263b3d027cc274c2f691a483))
- test ([#1201](https://github.com/loro-dev/lody/issues/1201))
  ([9d30440](https://github.com/loro-dev/lody/commit/9d3044079353f5251eaa1f0d5b7f0181e46929ef))
- unify electron app name as Lody
  ([#1318](https://github.com/loro-dev/lody/issues/1318))
  ([e704bbd](https://github.com/loro-dev/lody/commit/e704bbdfa2354ee9d5d5c85fb47edad18cf34556))
- use betterAuthClient for AuthClient auth validation
  ([#1161](https://github.com/loro-dev/lody/issues/1161))
  ([a83097a](https://github.com/loro-dev/lody/commit/a83097a61777ee5bf797cda1a7c527fa5ddce54b))
- windows deeplink callback and spawn shell options
  ([#1224](https://github.com/loro-dev/lody/issues/1224))
  ([22b03e8](https://github.com/loro-dev/lody/commit/22b03e831912bc4cfe12b72ed2eff045dd507902))
- windows electron
  ([2afa6a0](https://github.com/loro-dev/lody/commit/2afa6a0ef40d707cd66dfa0e6eb5eb48edf9b9db))
- windows electron
  ([e728487](https://github.com/loro-dev/lody/commit/e728487690e4254918e2e97ba07b8f17b39a486e))

### Refactors

- **electron:** modularize main entry and share IPC types
  ([#1115](https://github.com/loro-dev/lody/issues/1115))
  ([4eaf1b8](https://github.com/loro-dev/lody/commit/4eaf1b83fa30b279b599d8757a1829254373572c))
- remove remote git operations from local project flow to prevent timeout
  ([#1108](https://github.com/loro-dev/lody/issues/1108))
  ([c6a5370](https://github.com/loro-dev/lody/commit/c6a5370954e7ebca4916828d9f6c6edd3a3be13a))
- **settings:** split settings tabs and unify section headers
  ([#1242](https://github.com/loro-dev/lody/issues/1242))
  ([4ec87f1](https://github.com/loro-dev/lody/commit/4ec87f18c249c369a6619d78aaa2fc892050c445))
- support local project file mentions in electron
  ([#1101](https://github.com/loro-dev/lody/issues/1101))
  ([f9e4bc0](https://github.com/loro-dev/lody/commit/f9e4bc027d3ea4f4687dbf839939fbf779452041))

## [0.39.0](https://github.com/loro-dev/lody/compare/lody-electron-v0.38.0...lody-electron-v0.39.0) (2026-03-20)

### Chores

- **lody-electron:** Synchronize lody-cli-electron versions

## [0.38.0](https://github.com/loro-dev/lody/compare/lody-electron-v0.37.2...lody-electron-v0.38.0) (2026-03-19)

### Features

- release 2026-03-19
  ([8796e6e](https://github.com/loro-dev/lody/commit/8796e6e17cfa8b6ffc90986598b46c059d97ac09))

### Bug Fixes

- **electron:** avoid windows email input white screen
  ([#1410](https://github.com/loro-dev/lody/issues/1410))
  ([ca4b287](https://github.com/loro-dev/lody/commit/ca4b287cc51ccc954234cc3f4aa4be21d2111731))
- remove redundant --cli-types injection from Electron CLI launcher
  ([#1405](https://github.com/loro-dev/lody/issues/1405))
  ([a789382](https://github.com/loro-dev/lody/commit/a78938211bf860d303145855254ff72090fbccdd))

## [0.37.2](https://github.com/loro-dev/lody/compare/lody-electron-v0.37.1...lody-electron-v0.37.2) (2026-03-19)

### Bug Fixes

- cli trigger
  ([020a422](https://github.com/loro-dev/lody/commit/020a4225fcac8006c4223bb1bc8febccbdd7248b))

## [0.37.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.37.0...lody-electron-v0.37.1) (2026-03-18)

### Bug Fixes

- auto updater
  ([1857794](https://github.com/loro-dev/lody/commit/1857794c5fb1597a9ebe87d063f50eb5f65aa3da))
- electron auto updater
  ([3f4702d](https://github.com/loro-dev/lody/commit/3f4702d8fb8d5ea5a1182ffcacb178141832f5b9))

## [0.37.0](https://github.com/loro-dev/lody/compare/lody-electron-v0.36.0...lody-electron-v0.37.0) (2026-03-18)

### Features

- release 2026-03-18 ([#1389](https://github.com/loro-dev/lody/issues/1389))
  ([0aec1e5](https://github.com/loro-dev/lody/commit/0aec1e5de84886bc1d935243fdca5f9fbd5829a3))

### Bug Fixes

- chatmode compat ([#1375](https://github.com/loro-dev/lody/issues/1375))
  ([e513888](https://github.com/loro-dev/lody/commit/e513888b597e5df4507dd8feceff7bbe164e49f8))
- handle electron login route in packaged app
  ([#1387](https://github.com/loro-dev/lody/issues/1387))
  ([3559d4e](https://github.com/loro-dev/lody/commit/3559d4e834fe29e880d77c3b44a03fd2cef06755))

## [0.36.0](https://github.com/loro-dev/lody/compare/lody-electron-v0.35.0...lody-electron-v0.36.0) (2026-03-17)

### Features

- release 2026-0317 ([#1372](https://github.com/loro-dev/lody/issues/1372))
  ([d3d7812](https://github.com/loro-dev/lody/commit/d3d7812d577271cb8636306b2dbd7dc1788d0340))

## [0.35.0](https://github.com/loro-dev/lody/compare/lody-electron-v0.34.0...lody-electron-v0.35.0) (2026-03-12)

### Features

- release 2026-0312 ([#1331](https://github.com/loro-dev/lody/issues/1331))
  ([9a90d61](https://github.com/loro-dev/lody/commit/9a90d612bb5b405e3f5072f377b8615667ee65d3))
- show counts for collapsed sidebar groups
  ([9a90d61](https://github.com/loro-dev/lody/commit/9a90d612bb5b405e3f5072f377b8615667ee65d3))

### Bug Fixes

- csc name
  ([9a90d61](https://github.com/loro-dev/lody/commit/9a90d612bb5b405e3f5072f377b8615667ee65d3))
- csc name
  ([3e1535c](https://github.com/loro-dev/lody/commit/3e1535c9146529be1bc2dcb07f9a6fccd3af9089))
- **electron:** allow agentclientprotocol CDN in image CSP
  ([be39ffb](https://github.com/loro-dev/lody/commit/be39ffb0090a448f8186d08ebbf1b7104b649416))
- **electron:** allow agentclientprotocol cdn in img-src csp
  ([8f9e525](https://github.com/loro-dev/lody/commit/8f9e5251e88d4db370fa94e99dc17aac859d5b39))
- enable macos signing for electron releases
  ([#1321](https://github.com/loro-dev/lody/issues/1321))
  ([ad004e9](https://github.com/loro-dev/lody/commit/ad004e98ed20fa695ec2da032c84bfd5ec11e2b8))
- persist Electron window bounds
  ([#1304](https://github.com/loro-dev/lody/issues/1304))
  ([ccf9af4](https://github.com/loro-dev/lody/commit/ccf9af4bbedf70715b6ffe13518ea15b82d105ee))
- unify electron app name as Lody
  ([#1318](https://github.com/loro-dev/lody/issues/1318))
  ([e704bbd](https://github.com/loro-dev/lody/commit/e704bbdfa2354ee9d5d5c85fb47edad18cf34556))

## [0.34.0](https://github.com/loro-dev/lody/compare/lody-electron-v0.33.1...lody-electron-v0.34.0) (2026-03-06)

### Chores

- **lody-electron:** Synchronize lody-cli-electron versions

## [0.33.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.33.0...lody-electron-v0.33.1) (2026-03-05)

### Chores

- **lody-electron:** Synchronize lody-cli-electron versions

## [0.33.0](https://github.com/loro-dev/lody/compare/lody-electron-v0.32.5...lody-electron-v0.33.0) (2026-03-04)

### Features

- add built-in opencode ACP support
  ([#1221](https://github.com/loro-dev/lody/issues/1221))
  ([4e8b644](https://github.com/loro-dev/lody/commit/4e8b6447d9264f20e0ff354cc1bd0bedaddc6c60))
- optimize workspace usage delta retention and compaction
  ([#1253](https://github.com/loro-dev/lody/issues/1253))
  ([c1113de](https://github.com/loro-dev/lody/commit/c1113ded2bd0e5f61d3c66c239975aa50a4c8502))
- remove local project path mapping and persist absolute paths
  ([#1240](https://github.com/loro-dev/lody/issues/1240))
  ([5c991f8](https://github.com/loro-dev/lody/commit/5c991f89b2a8d7d46eba7c4f84e1edd70ea0b92b))

### Bug Fixes

- **electron:** add Windows tray menu and DevTools entry
  ([#1232](https://github.com/loro-dev/lody/issues/1232))
  ([ad3235c](https://github.com/loro-dev/lody/commit/ad3235caf7501ddb43328e3bd76dbadd978996fd))
- **electron:** prevent Windows file input crash and add image picker IPC
  fallback ([#1234](https://github.com/loro-dev/lody/issues/1234))
  ([ac623fd](https://github.com/loro-dev/lody/commit/ac623fd112a421c08b8688eca01ae85e4a598337))
- ensure electron update restart quits app reliably
  ([#1229](https://github.com/loro-dev/lody/issues/1229))
  ([640c354](https://github.com/loro-dev/lody/commit/640c3546760953577fdb9fb253001be7baf57cb8))
- preserve plan expand/collapse state across virtual scroll unmount
  ([#1261](https://github.com/loro-dev/lody/issues/1261))
  ([c78146d](https://github.com/loro-dev/lody/commit/c78146d53127658ccd348a60e630586c5ca5845f))
- windows deeplink callback and spawn shell options
  ([#1224](https://github.com/loro-dev/lody/issues/1224))
  ([22b03e8](https://github.com/loro-dev/lody/commit/22b03e831912bc4cfe12b72ed2eff045dd507902))

### Refactors

- **settings:** split settings tabs and unify section headers
  ([#1242](https://github.com/loro-dev/lody/issues/1242))
  ([4ec87f1](https://github.com/loro-dev/lody/commit/4ec87f18c249c369a6619d78aaa2fc892050c445))

## [0.32.5](https://github.com/loro-dev/lody/compare/lody-electron-v0.32.4...lody-electron-v0.32.5) (2026-02-26)

### Chores

- **lody-electron:** Synchronize lody-cli-electron versions

## [0.32.4](https://github.com/loro-dev/lody/compare/lody-electron-v0.32.3...lody-electron-v0.32.4) (2026-02-26)

### Bug Fixes

- windows electron
  ([2afa6a0](https://github.com/loro-dev/lody/commit/2afa6a0ef40d707cd66dfa0e6eb5eb48edf9b9db))

### Documentation

- changelog ([#1206](https://github.com/loro-dev/lody/issues/1206))
  ([ed8d295](https://github.com/loro-dev/lody/commit/ed8d295ec6606b2e9a94fde5f6e1b20b0be81cd6))

## [0.32.3](https://github.com/loro-dev/lody/compare/lody-electron-v0.32.2...lody-electron-v0.32.3) (2026-02-22)

### Bug Fixes

- ci only mac ([#1204](https://github.com/loro-dev/lody/issues/1204))
  ([3eb581a](https://github.com/loro-dev/lody/commit/3eb581a6842be747c5c69ae3dc58c7bc013bd64d))

## [0.32.2](https://github.com/loro-dev/lody/compare/lody-electron-v0.32.1...lody-electron-v0.32.2) (2026-02-22)

### Bug Fixes

- ci ([#1202](https://github.com/loro-dev/lody/issues/1202))
  ([5c107b8](https://github.com/loro-dev/lody/commit/5c107b8cb78af6b23517150ceb0cbeeb720fc2d2))

## [0.32.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.32.0...lody-electron-v0.32.1) (2026-02-22)

### Bug Fixes

- ci build ([#1199](https://github.com/loro-dev/lody/issues/1199))
  ([1074ad3](https://github.com/loro-dev/lody/commit/1074ad32867cc27e23c48ba9f050f4031926cc1d))
- test ([#1201](https://github.com/loro-dev/lody/issues/1201))
  ([9d30440](https://github.com/loro-dev/lody/commit/9d3044079353f5251eaa1f0d5b7f0181e46929ef))

## [0.32.0](https://github.com/loro-dev/lody/compare/lody-electron-v0.31.2...lody-electron-v0.32.0) (2026-02-22)

### Features

- add branch-aware session startup
  ([#1102](https://github.com/loro-dev/lody/issues/1102))
  ([bac1b50](https://github.com/loro-dev/lody/commit/bac1b5076ac3678f997427dff472691ebd003585))
- add electron local-first session control path
  ([#1169](https://github.com/loro-dev/lody/issues/1169))
  ([41d5e96](https://github.com/loro-dev/lody/commit/41d5e961bcb0d9258326da7c0cb2c362a2ffcddb))
- add multi-select mode to archive session view
  ([#1014](https://github.com/loro-dev/lody/issues/1014))
  ([3b03cfe](https://github.com/loro-dev/lody/commit/3b03cfefd5521820c4cee89fb97b6c3156baf088))
- **auth:** user-scoped CLI token + multi-workspace support
  ([#1048](https://github.com/loro-dev/lody/issues/1048))
  ([1da6f20](https://github.com/loro-dev/lody/commit/1da6f20dd6c2e25116da0973814b59a1c77dfc9d))
- basic electron ([#1015](https://github.com/loro-dev/lody/issues/1015))
  ([3019fc9](https://github.com/loro-dev/lody/commit/3019fc91ced6e8cbe1f03124bb10e6238e9a1bb4))
- bootstrap Electron CLI auth from session token
  ([#1148](https://github.com/loro-dev/lody/issues/1148))
  ([77b2bfa](https://github.com/loro-dev/lody/commit/77b2bfaf7bdef4d107bfc900773769c5ff2664ec))
- chat mentions ([#1028](https://github.com/loro-dev/lody/issues/1028))
  ([62d53c6](https://github.com/loro-dev/lody/commit/62d53c6845cd94aa8c491557b04a315ac9219a1c))
- **cli:** load environment variables based on runtime environment
  ([758d310](https://github.com/loro-dev/lody/commit/758d310e01d6ab93bccddcaee5bccfb4fdb15010))
- electron deeplink Auth ([#1142](https://github.com/loro-dev/lody/issues/1142))
  ([36bb712](https://github.com/loro-dev/lody/commit/36bb712df401988280fcd8e908a41f20acb46f3a))
- electron start cli ([#1047](https://github.com/loro-dev/lody/issues/1047))
  ([aed10db](https://github.com/loro-dev/lody/commit/aed10dbd8f25f7d6d9935483b48cbd03257822f2))
- **electron:** add auto-update flow with R2 release pipeline
  ([#1178](https://github.com/loro-dev/lody/issues/1178))
  ([3f5a48f](https://github.com/loro-dev/lody/commit/3f5a48f92827f5cfb053fcc441a3f63e064a85ba))
- **electron:** add desktop notification toggle with system settings guidance
  ([#1110](https://github.com/loro-dev/lody/issues/1110))
  ([293dc74](https://github.com/loro-dev/lody/commit/293dc74d555d83cda4640c5e37e03350d5613ecd))
- **electron:** close button hides window and restore from dock
  ([#1122](https://github.com/loro-dev/lody/issues/1122))
  ([965f160](https://github.com/loro-dev/lody/commit/965f160c63f8dc07283e717c5d90f2560d3cecda))
- **electron:** hide title bar on macOS and offset sidebar for traffic lights
  ([#1018](https://github.com/loro-dev/lody/issues/1018))
  ([5e67e82](https://github.com/loro-dev/lody/commit/5e67e82a2a57dc11d0b947a558727786e2d1fea2))
- **electron:** local projects
  ([#1060](https://github.com/loro-dev/lody/issues/1060))
  ([166bffe](https://github.com/loro-dev/lody/commit/166bffe8ec03758a82c7a8e49c9ab423b6c5f239))
- enable GitHub capabilities for linked local projects
  ([#1170](https://github.com/loro-dev/lody/issues/1170))
  ([a9b5d87](https://github.com/loro-dev/lody/commit/a9b5d87b71c3894037e2f2e8767155bcaab980d0))
- move local project implementation to CLI daemon
  ([#1192](https://github.com/loro-dev/lody/issues/1192))
  ([508b8c0](https://github.com/loro-dev/lody/commit/508b8c0adb0a5d2fb9b6ab3fd71343e3708ab6b7))
- release 2026-02-06
  ([3872d71](https://github.com/loro-dev/lody/commit/3872d7117283eb3b10ff4553e005604ee0a037b2))
- reuse local optimizations for in-action github worktrees
  ([#1128](https://github.com/loro-dev/lody/issues/1128))
  ([5f9b459](https://github.com/loro-dev/lody/commit/5f9b459abee13488b04e369149571a519d4498fe))

### Bug Fixes

- allow github avatar images in electron CSP
  ([#1103](https://github.com/loro-dev/lody/issues/1103))
  ([699d401](https://github.com/loro-dev/lody/commit/699d401185eda8483d3ac683f71b8217c93a8766))
- **ci:** inject electron convex deploy url for packaged builds
  ([#1183](https://github.com/loro-dev/lody/issues/1183))
  ([db696a4](https://github.com/loro-dev/lody/commit/db696a4543a2b751a0bca526c561048e80b6bf91))
- do deploy
  ([a01fcba](https://github.com/loro-dev/lody/commit/a01fcba1e3c582cb79533aa1e2e62301df335807))
- electron ci
  ([6884d33](https://github.com/loro-dev/lody/commit/6884d332b6b1733cca8ba1261dcfad02eb4c9094))
- electron ci
  ([0efe2fd](https://github.com/loro-dev/lody/commit/0efe2fd7787ce563c5b2d3091de89a287d9b2d62))
- **electron:** fix local project worker module resolution after packaging
  ([#1144](https://github.com/loro-dev/lody/issues/1144))
  ([2899c76](https://github.com/loro-dev/lody/commit/2899c76ff3f04e709982a60238d241085fef2f6a))
- **electron:** normalize convex site url for ci auth
  ([#1185](https://github.com/loro-dev/lody/issues/1185))
  ([e3e93bd](https://github.com/loro-dev/lody/commit/e3e93bd10a35f9daea9fc9ba4c631d6c63426c03))
- handle Electron refresh under file:// routes
  ([#1187](https://github.com/loro-dev/lody/issues/1187))
  ([211671f](https://github.com/loro-dev/lody/commit/211671f06bb5cad5f5d483a06869376bc7e33ef7))
- reduce electron drag area height to avoid blocking buttons
  ([#1109](https://github.com/loro-dev/lody/issues/1109))
  ([6625b93](https://github.com/loro-dev/lody/commit/6625b93d151ad8c9d4932871f3e95699dea57f0f))
- use betterAuthClient for AuthClient auth validation
  ([#1161](https://github.com/loro-dev/lody/issues/1161))
  ([a83097a](https://github.com/loro-dev/lody/commit/a83097a61777ee5bf797cda1a7c527fa5ddce54b))

### Refactors

- **electron:** modularize main entry and share IPC types
  ([#1115](https://github.com/loro-dev/lody/issues/1115))
  ([4eaf1b8](https://github.com/loro-dev/lody/commit/4eaf1b83fa30b279b599d8757a1829254373572c))
- remove remote git operations from local project flow to prevent timeout
  ([#1108](https://github.com/loro-dev/lody/issues/1108))
  ([c6a5370](https://github.com/loro-dev/lody/commit/c6a5370954e7ebca4916828d9f6c6edd3a3be13a))
- support local project file mentions in electron
  ([#1101](https://github.com/loro-dev/lody/issues/1101))
  ([f9e4bc0](https://github.com/loro-dev/lody/commit/f9e4bc027d3ea4f4687dbf839939fbf779452041))

## [0.31.14-next.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.31.13-next.1...lody-electron-v0.31.14-next.1) (2026-02-22)

### Features

- move local project implementation to CLI daemon
  ([#1192](https://github.com/loro-dev/lody/issues/1192))
  ([508b8c0](https://github.com/loro-dev/lody/commit/508b8c0adb0a5d2fb9b6ab3fd71343e3708ab6b7))

### Bug Fixes

- handle Electron refresh under file:// routes
  ([#1187](https://github.com/loro-dev/lody/issues/1187))
  ([211671f](https://github.com/loro-dev/lody/commit/211671f06bb5cad5f5d483a06869376bc7e33ef7))

## [0.31.13-next.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.31.12-next.1...lody-electron-v0.31.13-next.1) (2026-02-21)

### Bug Fixes

- **electron:** normalize convex site url for ci auth
  ([#1185](https://github.com/loro-dev/lody/issues/1185))
  ([e3e93bd](https://github.com/loro-dev/lody/commit/e3e93bd10a35f9daea9fc9ba4c631d6c63426c03))

## [0.31.12-next.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.31.11-next.1...lody-electron-v0.31.12-next.1) (2026-02-21)

### Bug Fixes

- **ci:** inject electron convex deploy url for packaged builds
  ([#1183](https://github.com/loro-dev/lody/issues/1183))
  ([db696a4](https://github.com/loro-dev/lody/commit/db696a4543a2b751a0bca526c561048e80b6bf91))

## [0.31.11-next.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.31.10-next.1...lody-electron-v0.31.11-next.1) (2026-02-21)

### Chores

- **lody-electron:** Synchronize lody-cli-electron versions

## [0.31.10-next.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.31.9-next.1...lody-electron-v0.31.10-next.1) (2026-02-21)

### Bug Fixes

- electron ci
  ([6884d33](https://github.com/loro-dev/lody/commit/6884d332b6b1733cca8ba1261dcfad02eb4c9094))

## [0.31.9-next.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.31.8-next.1...lody-electron-v0.31.9-next.1) (2026-02-21)

### Bug Fixes

- electron ci
  ([0efe2fd](https://github.com/loro-dev/lody/commit/0efe2fd7787ce563c5b2d3091de89a287d9b2d62))

## [0.31.8-next.1](https://github.com/loro-dev/lody/compare/lody-electron-v0.31.7-next.1...lody-electron-v0.31.8-next.1) (2026-02-20)

### Features

- add branch-aware session startup
  ([#1102](https://github.com/loro-dev/lody/issues/1102))
  ([bac1b50](https://github.com/loro-dev/lody/commit/bac1b5076ac3678f997427dff472691ebd003585))
- add electron local-first session control path
  ([#1169](https://github.com/loro-dev/lody/issues/1169))
  ([41d5e96](https://github.com/loro-dev/lody/commit/41d5e961bcb0d9258326da7c0cb2c362a2ffcddb))
- add multi-select mode to archive session view
  ([#1014](https://github.com/loro-dev/lody/issues/1014))
  ([3b03cfe](https://github.com/loro-dev/lody/commit/3b03cfefd5521820c4cee89fb97b6c3156baf088))
- **auth:** user-scoped CLI token + multi-workspace support
  ([#1048](https://github.com/loro-dev/lody/issues/1048))
  ([1da6f20](https://github.com/loro-dev/lody/commit/1da6f20dd6c2e25116da0973814b59a1c77dfc9d))
- basic electron ([#1015](https://github.com/loro-dev/lody/issues/1015))
  ([3019fc9](https://github.com/loro-dev/lody/commit/3019fc91ced6e8cbe1f03124bb10e6238e9a1bb4))
- bootstrap Electron CLI auth from session token
  ([#1148](https://github.com/loro-dev/lody/issues/1148))
  ([77b2bfa](https://github.com/loro-dev/lody/commit/77b2bfaf7bdef4d107bfc900773769c5ff2664ec))
- chat mentions ([#1028](https://github.com/loro-dev/lody/issues/1028))
  ([62d53c6](https://github.com/loro-dev/lody/commit/62d53c6845cd94aa8c491557b04a315ac9219a1c))
- **cli:** load environment variables based on runtime environment
  ([758d310](https://github.com/loro-dev/lody/commit/758d310e01d6ab93bccddcaee5bccfb4fdb15010))
- electron deeplink Auth ([#1142](https://github.com/loro-dev/lody/issues/1142))
  ([36bb712](https://github.com/loro-dev/lody/commit/36bb712df401988280fcd8e908a41f20acb46f3a))
- electron start cli ([#1047](https://github.com/loro-dev/lody/issues/1047))
  ([aed10db](https://github.com/loro-dev/lody/commit/aed10dbd8f25f7d6d9935483b48cbd03257822f2))
- **electron:** add auto-update flow with R2 release pipeline
  ([#1178](https://github.com/loro-dev/lody/issues/1178))
  ([3f5a48f](https://github.com/loro-dev/lody/commit/3f5a48f92827f5cfb053fcc441a3f63e064a85ba))
- **electron:** add desktop notification toggle with system settings guidance
  ([#1110](https://github.com/loro-dev/lody/issues/1110))
  ([293dc74](https://github.com/loro-dev/lody/commit/293dc74d555d83cda4640c5e37e03350d5613ecd))
- **electron:** close button hides window and restore from dock
  ([#1122](https://github.com/loro-dev/lody/issues/1122))
  ([965f160](https://github.com/loro-dev/lody/commit/965f160c63f8dc07283e717c5d90f2560d3cecda))
- **electron:** hide title bar on macOS and offset sidebar for traffic lights
  ([#1018](https://github.com/loro-dev/lody/issues/1018))
  ([5e67e82](https://github.com/loro-dev/lody/commit/5e67e82a2a57dc11d0b947a558727786e2d1fea2))
- **electron:** local projects
  ([#1060](https://github.com/loro-dev/lody/issues/1060))
  ([166bffe](https://github.com/loro-dev/lody/commit/166bffe8ec03758a82c7a8e49c9ab423b6c5f239))
- enable GitHub capabilities for linked local projects
  ([#1170](https://github.com/loro-dev/lody/issues/1170))
  ([a9b5d87](https://github.com/loro-dev/lody/commit/a9b5d87b71c3894037e2f2e8767155bcaab980d0))
- reuse local optimizations for in-action github worktrees
  ([#1128](https://github.com/loro-dev/lody/issues/1128))
  ([5f9b459](https://github.com/loro-dev/lody/commit/5f9b459abee13488b04e369149571a519d4498fe))

### Bug Fixes

- allow github avatar images in electron CSP
  ([#1103](https://github.com/loro-dev/lody/issues/1103))
  ([699d401](https://github.com/loro-dev/lody/commit/699d401185eda8483d3ac683f71b8217c93a8766))
- do deploy
  ([a01fcba](https://github.com/loro-dev/lody/commit/a01fcba1e3c582cb79533aa1e2e62301df335807))
- **electron:** fix local project worker module resolution after packaging
  ([#1144](https://github.com/loro-dev/lody/issues/1144))
  ([2899c76](https://github.com/loro-dev/lody/commit/2899c76ff3f04e709982a60238d241085fef2f6a))
- reduce electron drag area height to avoid blocking buttons
  ([#1109](https://github.com/loro-dev/lody/issues/1109))
  ([6625b93](https://github.com/loro-dev/lody/commit/6625b93d151ad8c9d4932871f3e95699dea57f0f))
- use betterAuthClient for AuthClient auth validation
  ([#1161](https://github.com/loro-dev/lody/issues/1161))
  ([a83097a](https://github.com/loro-dev/lody/commit/a83097a61777ee5bf797cda1a7c527fa5ddce54b))

### Refactors

- **electron:** modularize main entry and share IPC types
  ([#1115](https://github.com/loro-dev/lody/issues/1115))
  ([4eaf1b8](https://github.com/loro-dev/lody/commit/4eaf1b83fa30b279b599d8757a1829254373572c))
- remove remote git operations from local project flow to prevent timeout
  ([#1108](https://github.com/loro-dev/lody/issues/1108))
  ([c6a5370](https://github.com/loro-dev/lody/commit/c6a5370954e7ebca4916828d9f6c6edd3a3be13a))
- support local project file mentions in electron
  ([#1101](https://github.com/loro-dev/lody/issues/1101))
  ([f9e4bc0](https://github.com/loro-dev/lody/commit/f9e4bc027d3ea4f4687dbf839939fbf779452041))

## Changelog
