#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { SPARKLE, sparkleDistribution, validPublicKey } from './sparkle-distribution.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'darwin') throw new Error('Update key setup requires macOS Keychain');
if (process.argv.length !== 2) throw new Error('Usage: npm run updates:key (uses only the dedicated Co² Keychain account; never exports a private key)');
const cache = path.join(root, '.coop/build-cache');
await fs.mkdir(cache, { recursive: true, mode: 0o700 }); await fs.chmod(path.join(root, '.coop'), 0o700);
const { distribution } = await sparkleDistribution(cache);
const tool = path.join(distribution, 'bin/generate_keys');
// Running this explicit maintainer command is the only code path that creates
// a production signing key. The dedicated account does not inspect other keys.
execFileSync(tool, ['--account', SPARKLE.account], { stdio: 'inherit' });
const publicKey = execFileSync(tool, ['--account', SPARKLE.account, '-p'], { encoding: 'utf8' }).trim();
if (!validPublicKey(publicKey)) throw new Error('Sparkle did not return a valid public signing key');
const releaseFile = path.join(root, 'macos/release.json');
const release = JSON.parse(await fs.readFile(releaseFile, 'utf8'));
if (release.publicKey && release.publicKey !== publicKey) throw new Error('The configured public key differs; explicit key rotation is required');
await fs.writeFile(releaseFile, JSON.stringify({ ...release, publicKey }, null, 2) + '\n');
console.log('Saved only the public update key to macos/release.json. Review and commit that public metadata before producing release assets. The private key remains in Keychain.');
