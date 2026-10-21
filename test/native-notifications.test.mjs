import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

test('native notification ledger suppresses repeated snapshots, handles authorization and resets resolved groups', { skip: process.platform !== 'darwin' }, async () => {
  // Execute the actual Swift ledger, without launching an app, accessing the
  // notification store or asking for OS permission. This is not banner/UI proof.
  const source = await fs.readFile(new URL('../macos/App.swift', import.meta.url), 'utf8');
  const ledger = source.slice(source.indexOf('struct AttentionLedger {'), source.indexOf('final class AppDelegate'));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'co2-notification-ledger-'));
  try {
    const file = path.join(dir, 'test.swift');
    await fs.writeFile(file, ledger + `
var ledger = AttentionLedger()
let first: [String: Set<String>] = ["r1:guest": ["g1"]]
precondition(ledger.reconcile(first, enabled: false).isEmpty)
precondition(ledger.reconcile(first, enabled: true) == ["r1:guest"])
precondition(ledger.reconcile(first, enabled: true).isEmpty)
precondition(ledger.reconcile(["r1:guest": ["g1", "g2"]], enabled: true) == ["r1:guest"])
precondition(ledger.reconcile(first, enabled: true).isEmpty)
precondition(ledger.reconcile([:], enabled: false).isEmpty)
precondition(ledger.reconcile(first, enabled: true) == ["r1:guest"])
precondition(ledger.reconcile(["r1:guest": ["g1"], "r2:guest": ["g1"]], enabled: true) == ["r2:guest"])
print("ledger passed")
`);
    assert.equal(execFileSync('/usr/bin/swift', [file], { encoding: 'utf8', timeout: 30000 }).trim(), 'ledger passed');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
