import { readFileSync } from 'node:fs';

// Application metadata only. Native bundles provide their installed build and
// update capability through the trusted WebView bridge, never through guests.
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
export const appInfo = Object.freeze({ name: 'Codex Co²', version, build: null, channel: 'source', canUpdate: false });
