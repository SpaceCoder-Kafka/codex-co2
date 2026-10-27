# Contributing

Codex Co² is an experimental, independent project. Focused fixes and reproducible reports are welcome. Contributions are provided under the project's MIT license; submit only work you have the right to license.

Use Node.js 22.23.3 and install with `npm ci --ignore-scripts`. Tests do not need default Codex credentials or conversation files.

```sh
npm test
npm run check:public
npm run notices:check
npm run test:licenses
```

Unit runs intentionally skip four isolated-backend suites. To run them, provide an absolute path to **Codex CLI 0.163.0**. This pin is for isolated tests only; do not downgrade or replace your daily Desktop.

Use its native executable, not npm's `node_modules/.bin/codex` launcher: isolated fixtures deliberately exclude development tools from PATH. CI extracts the native executable from its separately installed, pinned test package.

```sh
CODEX_COOP_CLI=/absolute/path/to/codex-0.163.0 npm run test:integration:required
```

The required runner fails if the exact backend is unavailable, any integration is skipped, or a test fails. Fixtures use temporary homes, synthetic credentials and a local Responses server. They make no real model calls. Scripted clients do not prove native UI behavior.

For transport or lifecycle changes run both `npm test` and `npm run test:integration:required`. Preserve conversation authorization across requests, responses, notifications and execution capabilities. Native tool approvals belong to the host. Keep compatibility identifiers and retired SSH cleanup markers intact; host-level SSH sharing is not supported.

For Universal macOS builds use an Apple Silicon or Intel Mac, Xcode command line tools and Python 3.9+:

```sh
npm run updates:key
npm run build:macos
npm run check:macos
```

`updates:key` explicitly creates or reuses a dedicated update-signing key in macOS Keychain and saves only its public key to `macos/release.json`. Review that public metadata before building. Production builds require this configured public key (or `CO2_UPDATE_PUBLIC_KEY`) and fail closed when it is missing. The updater uses pinned Sparkle binaries and signed metadata and archives; retain the private signing key independently of Codex credentials.

`CO2_BUILD_DIST` selects a separate output directory. Outputs and caches are ignored. Builds record a digest of the public source file set; associate the reviewed public source commit with the Release. Do not replace a running installation during tests. `CO2_BUILD_UPDATE_TESTING=1 npm run build:macos` creates an explicitly non-distributable bundle with a temporary test signing seed under the ignored build cache; it never accesses Keychain. An explicit loopback `CO2_UPDATE_FEED_URL` is allowed only for these test bundles. Test bundles must not be published or installed over a user's app.

## Versioning and releases

Product versions in `package.json` follow semantic versioning from **0.1.0**: patch releases fix bugs (0.1.1), minor releases add functionality (0.2.0), and major releases mark a stable compatibility milestone. During 0.x, document breaking changes explicitly in the next minor release. Update the root and package versions in `package-lock.json` together. Add a user-facing CHANGELOG entry for each version before building; both platform builders use it to generate release notes.

Application build numbers in `macos/release.json` increase globally, including across application versions and channels. Rebuilding the same product version consumes a new Build. Normal releases use channel `stable`, tag `v<version>` and title `Codex Co² <version>`; previews use channel `preview` and tag `v<version>-preview.<build>`. Published tags and asset bytes are never reused. Explicitly select a normal release as GitHub Latest, even when its product version is lower than historical previews.

After verifying a production bundle, prepare signed update metadata locally:

```sh
npm run updates:prepare -- --app "dist/Codex Co².app" --dmg dist/Codex-Co2-0.2.0-build24-universal.dmg --output dist/appcast.xml --previous-feed dist/previous-appcast.xml
```

Use `--initial` only for the first feed. Later updates must pass `--previous-feed <previous-signed-appcast.xml>` instead, preserving older channel entries and checking the global build increase. Preparation verifies the DMG, source inventory, embedded bundle and matching signing key, and does not publish anything. Publish matching Release assets first, then the signed feed unchanged as `appcast.xml` on the existing repository's separate `updates` branch. Keep generated appcasts outside the source inventory to avoid a digest cycle. Coordinate `auto_updates true` in the existing Homebrew cask when publishing the first updater-enabled release. Build 16 and earlier need a manual upgrade. The 0.3.3 → 0.1.0/0.2.0 transition uses an increasing Build; manual Homebrew migration requires a one-time `brew reinstall --cask SpaceCoder-Kafka/tap/codex-co2`.

To retire a previously published update, pass `--retire-build <build>` once per entry, together with `--previous-feed`. The tool verifies the previous feed signature and checks the new Build against **all** previous items before removing selected entries and signing the new feed. Unknown, duplicate and invalid retirement numbers fail. Without this option, every old entry is preserved. Archive and verify the old public release metadata, assets, tag commits, signed feed and cask before retirement. Publish and verify replacement assets, then the new signed feed and cask, before deleting any old Release. Keep old Git tags and historical evidence. Never reset the feed with `--initial` to bypass continuity checks.

Release notes should explain user-visible changes, upgrade steps and known limitations in Chinese and English. Keep detailed acceptance logs in maintainer records. A `stable` channel does not imply Apple notarization, Windows signing or clean-machine/native acceptance. Preserve the actual signing status and remaining gaps.

Universal builds combine separately verified arm64 and x86_64 main executables, Node and cloudflared. Sparkle and every native helper must also contain both slices. Inspect minimum macOS and linked libraries per slice; the host-native runtime check does not prove the other architecture works. Each cloudflared slice gets its own verified Go module/license inventory. Keep historical ARM appcast items unchanged.

The Universal package targets macOS **14.0**. `scripts/cloudflared-macos.mjs` builds the pinned cloudflared source with a verified Go toolchain and an explicit deployment target for each architecture; it does not use an arbitrary local binary or patch an existing binary's minimum-version metadata. Downloads, isolated build state and toolchains stay in `.coop/`; no global Go installation is required. Preserve the source/toolchain checksums and per-architecture build provenance in the release manifest. Dependency updates must continue to pass the deployment-target gate.

CI builds and checks these targets on macOS 26. GitHub's hosted macOS 14 images [retire on November 2, 2026](https://github.blog/changelog/2026-10-01-github-actions-macos-14-runner-image-retirement/), so the workflow does not depend on those labels. Before claiming native macOS 14 acceptance, use a macOS 14 test machine to verify installation, compatible official Desktop attachment, native approvals, sharing/reconnection, notifications and app updates. Validate Intel and Apple Silicon separately. A newer-host build or synthetic IPC test is not macOS 14 runtime acceptance.

## Windows builds

Use .NET SDK **8.0.426**, NSIS **3.13**, Python 3.9+ and Node.js **22.23.3**. Build a self-contained x64 application, per-user setup EXE and portable ZIP with `npm run build:windows`, then run `npm run check:windows`. The target is Windows 10 version 1809+ and Windows 11; the shell requires Microsoft Edge WebView2 Runtime. Windows packages are unsigned experimental builds and provide manual downloads instead of an unverified automatic updater. Keep private runtime state in `.coop/` with a same-user Windows ACL. The existing Desktop pipe and index must pass ownership/ACL checks before attachment; do not relax these checks to make an incompatible Desktop work.

Cross-builds on macOS require the same .NET SDK and NSIS; generated PE files still need native Windows checks. Neither package verification nor synthetic IPC tests establish real Desktop, native approval or clean-machine acceptance. Windows artifacts carry their own checksums, source inventory and bundled-runtime notices. Do not install over a running app during tests.

After dependency changes, run `npm ci --ignore-scripts`, regenerate notices with `npm run notices:write`, and review license changes. Builds check notices against a fresh lockfile installation.

PRs should explain user-visible behavior, validation and remaining limitations. Bug reports need app/build, Desktop and operating-system versions, synthetic reproductions and redacted evidence. Use [private reporting](SECURITY.md) for vulnerabilities.

Maintainers can prepare a separate public candidate with:

```sh
npm run export:public -- /absolute/path/to/new-public-candidate
```

The destination must not exist and must be outside this checkout. Export copies only `scripts/public-files.json`, scans it and stages a new `main` branch. It does not copy history, set an author, commit, configure a remote or publish. Review the adjacent `.review.json`, configure a public Git identity, then create the initial commit. Add new public files to the allowlist explicitly.
