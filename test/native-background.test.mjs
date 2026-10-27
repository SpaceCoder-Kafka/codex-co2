import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));

test('native background preferences fail closed and preserve runtime selection without reading real user state', { skip: process.platform !== 'darwin' }, async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'co2-native-background-'));
  try {
    const script = path.join(temporary, 'main.swift'), binary = path.join(temporary, 'fixture');
    await fs.writeFile(script, `import Foundation
import ServiceManagement

let home = URL(fileURLWithPath: CommandLine.arguments[1]).resolvingSymlinksInPath()
let fm = FileManager.default
let runtime = BackgroundConfiguration.defaultRuntime(home: home)
try fm.createDirectory(at: runtime, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
precondition(try! BackgroundConfiguration.enabled(runtime: runtime))
precondition(try! BackgroundConfiguration.runtime(arguments: [], home: home).path == runtime.path)
let preference = runtime.appendingPathComponent("background-settings.json")
func store(_ value: [String: Any], mode: Int = 0o600) throws {
    let bytes = try JSONSerialization.data(withJSONObject: value)
    try bytes.write(to: preference)
    try fm.setAttributes([.posixPermissions: mode], ofItemAtPath: preference.path)
}
func rejected(_ operation: () throws -> Void) {
    do { try operation(); preconditionFailure("Unsafe background state accepted") } catch { }
}
try store(["version": 1, "enabled": false])
precondition(try! !BackgroundConfiguration.enabled(runtime: runtime))
try store(["version": 1, "enabled": true])
precondition(try! BackgroundConfiguration.enabled(runtime: runtime))
for data: [String: Any] in [["version": 1, "enabled": 1], ["version": 1, "enabled": "true"],
                          ["version": 2, "enabled": true], ["version": 1, "enabled": true, "extra": true]] {
    try store(data); rejected { _ = try BackgroundConfiguration.enabled(runtime: runtime) }
}
try store(["version": 1, "enabled": true], mode: 0o644)
rejected { _ = try BackgroundConfiguration.enabled(runtime: runtime) }
try fm.removeItem(at: preference)
let target = runtime.appendingPathComponent("synthetic-target.json")
try Data("{\\"version\\":1,\\"enabled\\":true}".utf8).write(to: target)
try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: target.path)
try fm.createSymbolicLink(at: preference, withDestinationURL: target)
rejected { _ = try BackgroundConfiguration.enabled(runtime: runtime) }
try fm.removeItem(at: preference)
try Data(repeating: 65, count: 4097).write(to: preference)
try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: preference.path)
rejected { _ = try BackgroundConfiguration.enabled(runtime: runtime) }

precondition(BackgroundConfiguration.action(["action": "status"])?.0 == "status")
precondition(BackgroundConfiguration.action(["action": "settings"])?.0 == "settings")
precondition(BackgroundConfiguration.action(["action": "set", "enabled": false])?.1 == false)
precondition(BackgroundConfiguration.action(["action": "set", "enabled": true])?.1 == true)
precondition(BackgroundConfiguration.action(["action": "set", "enabled": 1]) == nil)
precondition(BackgroundConfiguration.action(["action": "set", "enabled": true, "command": "unsafe"]) == nil)
precondition(BackgroundConfiguration.action(["action": "shutdown"]) == nil)
precondition(BackgroundConfiguration.action(["action": "status", "path": "/tmp/untrusted"]) == nil)

let setting = runtime.appendingPathComponent("app-settings.json")
try Data("{\\"runtimeDirectory\\":\\"/tmp/old/.coop\\",\\"futurePreference\\":true}".utf8).write(to: setting)
try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: setting.path)
let selected = home.appendingPathComponent("selected/.coop")
try BackgroundConfiguration.saveRuntime(selected, home: home)
let saved = try BackgroundConfiguration.privateJSON(setting)!
precondition(saved["futurePreference"] as? Bool == true)
precondition(saved["runtimeDirectory"] as? String == selected.path)
precondition(try! BackgroundConfiguration.runtime(arguments: [], home: home).path == selected.path)
precondition(try! BackgroundConfiguration.runtime(arguments: ["app", "--runtime-dir", runtime.path], home: home).path == runtime.path)
rejected { _ = try BackgroundConfiguration.runtime(arguments: ["app", "--runtime-dir"], home: home) }
rejected { _ = try BackgroundConfiguration.runtime(arguments: ["app", "--runtime-dir", "relative/.coop"], home: home) }
rejected { _ = try BackgroundConfiguration.runtime(arguments: ["app", "--runtime-dir", "/tmp/not-runtime"], home: home) }

let env = BackgroundConfiguration.environment(resources: home, home: home,
    source: ["LANG": "en_US.UTF-8", "USER": "synthetic", "OPENAI_API_KEY": "synthetic-not-forwarded", "CODEX_HOME": "/tmp/forbidden"])
precondition(env["OPENAI_API_KEY"] == nil && env["CODEX_HOME"] == nil)
precondition(env["HOME"] == home.path && env["USER"] == "synthetic")
let args = BackgroundConfiguration.arguments(resources: home, runtime: selected, mode: "--daemon")
precondition(args.contains("--daemon") && args.contains("--attach") && args.contains(selected.path))
precondition(!args.contains("--cli"))

// An independent managed daemon survives a lost GUI pipe or is restarted by
// launchd. Foreground ownership, explicit stops, and exhausted attempts do not.
precondition(BackgroundBridgePolicy.reconnectDelay(attempt: 1, wasConnected: false, managedAvailable: false, intentionalStop: false) == 0.25)
precondition(BackgroundBridgePolicy.reconnectDelay(attempt: 0, wasConnected: true, managedAvailable: true, intentionalStop: false) == 0.25)
precondition(BackgroundBridgePolicy.reconnectDelay(attempt: 0, wasConnected: true, managedAvailable: false, intentionalStop: false) == nil)
precondition(BackgroundBridgePolicy.reconnectDelay(attempt: 0, wasConnected: false, managedAvailable: true, intentionalStop: true) == nil)
precondition(BackgroundBridgePolicy.reconnectDelay(attempt: 0, wasConnected: true, managedAvailable: true, intentionalStop: true) == nil)
precondition(BackgroundBridgePolicy.reconnectDelay(attempt: 40, wasConnected: false, managedAvailable: true, intentionalStop: false) == nil)
precondition(BackgroundBridgePolicy.reconnectDelay(attempt: 39, wasConnected: false, managedAvailable: true, intentionalStop: false) == 2)

// Exercise the real registration decision with an injected service operation;
// no test registers or unregisters a LaunchAgent on the developer's machine.
for initial: SMAppService.Status in [.notRegistered, .notFound] {
    var status = initial, calls = 0
    try BackgroundRegistrationPolicy.registerIfNeeded(status: { status }, register: { calls += 1; status = .enabled })
    precondition(calls == 1 && status == .enabled)
}
for initial: SMAppService.Status in [.enabled, .requiresApproval] {
    var calls = 0
    try BackgroundRegistrationPolicy.registerIfNeeded(status: { initial }, register: { calls += 1 })
    precondition(calls == 0)
}
var pendingStatus: SMAppService.Status = .notRegistered
try BackgroundRegistrationPolicy.registerIfNeeded(status: { pendingStatus }, register: { pendingStatus = .requiresApproval })
precondition(pendingStatus == .requiresApproval)
rejected { try BackgroundRegistrationPolicy.registerIfNeeded(status: { .notFound }, register: { }) }
do {
    try BackgroundRegistrationPolicy.registerIfNeeded(status: { .notFound }, register: {
        throw NSError(domain: "SyntheticRegistration", code: 108)
    })
    preconditionFailure("Registration error was swallowed")
} catch {
    precondition((error as NSError).domain == "SyntheticRegistration" && (error as NSError).code == 108)
}
precondition(BackgroundRegistrationPolicy.foregroundStatus(registration: "unavailable", connected: true, pendingEnable: false) == "unavailable")
precondition(BackgroundRegistrationPolicy.foregroundStatus(registration: "unavailable", connected: true, pendingEnable: true) == "unavailable")
precondition(BackgroundRegistrationPolicy.foregroundStatus(registration: "not-registered", connected: true, pendingEnable: false) == "unavailable")
precondition(BackgroundRegistrationPolicy.foregroundStatus(registration: "not-registered", connected: true, pendingEnable: true) == "pending-restart")
precondition(BackgroundRegistrationPolicy.foregroundStatus(registration: "enabled", connected: true, pendingEnable: false) == "pending-restart")
precondition(BackgroundRegistrationPolicy.foregroundStatus(registration: "requires-approval", connected: true, pendingEnable: true) == "requires-approval")
print("native background configuration passed")
`);
    execFileSync('/usr/bin/swiftc', ['-framework', 'AppKit', '-framework', 'ServiceManagement',
      path.join(root, 'macos/BackgroundService.swift'), script, '-o', binary], { stdio: 'pipe', timeout: 30000 });
    assert.equal(execFileSync(binary, [temporary], { encoding: 'utf8', timeout: 10000 }).trim(), 'native background configuration passed');
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});

test('bundled background launch configuration is per-user, uses reviewed executable and does not log capabilities', { skip: process.platform !== 'darwin' }, () => {
  // Inspect the source plist only. Never register or load a real LaunchAgent.
  const config = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-',
    path.join(root, 'macos/local.codexco2.sharing.plist')], { encoding: 'utf8' }));
  assert.equal(config.Label, 'local.codexco2.sharing');
  assert.equal(config.BundleProgram, 'Contents/MacOS/CodexCo2');
  assert.deepEqual(config.ProgramArguments, ['CodexCo2', '--background-service']);
  assert.deepEqual(config.KeepAlive, { SuccessfulExit: false });
  assert.equal(config.LimitLoadToSessionType, 'Aqua');
  assert.equal(config.RunAtLoad, true);
  assert.equal(config.StandardOutPath, '/dev/null');
  assert.equal(config.StandardErrorPath, '/dev/null');
  assert.equal(config.UserName, undefined);
  assert.equal(config.Program, undefined);
});
