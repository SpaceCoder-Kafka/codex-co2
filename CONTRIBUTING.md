# Contributing

For a bug report, include the Co² build, Codex Desktop and OS versions, and steps to reproduce with synthetic data. Report vulnerabilities through the [private reporting channel](SECURITY.md).

## Run the tests

Use the Node.js version in `.node-version`. From the repository root, run the following commands.

```sh
npm ci --ignore-scripts
npm test
npm run check:public
npm run notices:check
npm run test:licenses
```

For transport or lifecycle changes, also run the isolated integration tests. Set `CODEX_COOP_CLI` to the absolute path of the native Codex CLI **0.163.0** executable. This version pin applies only to tests. The runner uses temporary homes, synthetic credentials and a local model fixture, and fails if any integration is skipped.

```sh
CODEX_COOP_CLI=/absolute/path/to/codex-0.163.0 npm run test:integration:required
```

After changing dependencies, regenerate the notices with `npm run notices:write`, review the changes and rerun `npm run notices:check`.

## Submit a pull request

Describe what changes for the user, which tests you ran and any remaining limitations. Use synthetic data in logs and screenshots. Submit only work you can license under the project's [MIT license](LICENSE).
