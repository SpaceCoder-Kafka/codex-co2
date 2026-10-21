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

For macOS builds use an Apple Silicon Mac, Xcode command line tools and Python 3.9+:

```sh
npm run build:macos
npm run check:macos
```

`CO2_BUILD_DIST` selects a separate output directory. Outputs and caches are ignored. Builds record a digest of the public source file set; associate the reviewed public source commit with the Release. Do not replace a running installation during tests.

After dependency changes, run `npm ci --ignore-scripts`, regenerate notices with `npm run notices:write`, and review license changes. Builds check notices against a fresh lockfile installation.

PRs should explain user-visible behavior, validation and remaining limitations. Bug reports need app/build, Desktop and operating-system versions, synthetic reproductions and redacted evidence. Use [private reporting](SECURITY.md) for vulnerabilities.

Maintainers can prepare a separate public candidate with:

```sh
npm run export:public -- /absolute/path/to/new-public-candidate
```

The destination must not exist and must be outside this checkout. Export copies only `scripts/public-files.json`, scans it and stages a new `main` branch. It does not copy history, set an author, commit, configure a remote or publish. Review the adjacent `.review.json`, configure a public Git identity, then create the initial commit. Add new public files to the allowlist explicitly.
