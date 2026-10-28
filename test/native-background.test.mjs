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

// A signing classification is metadata only; it must not register a service.
precondition(BackgroundSigningPolicy.classify(flags: nil, teamIdentifier: "TEAM123456") == .unavailable)
precondition(BackgroundSigningPolicy.classify(flags: 2, teamIdentifier: nil) == .adHoc)
precondition(BackgroundSigningPolicy.classify(flags: 2, teamIdentifier: "TEAM123456") == .adHoc)
precondition(BackgroundSigningPolicy.classify(flags: 0, teamIdentifier: "TEAM123456") == .identified)
precondition(BackgroundSigningPolicy.classify(flags: 0, teamIdentifier: "") == .unavailable)
precondition(BackgroundSigningPolicy.classify(flags: 0, teamIdentifier: "invalid team") == .unavailable)
precondition(BackgroundSigningPolicy.classify(flags: 0, teamIdentifier: nil) == .unavailable)
precondition(BackgroundSigningPolicy.current() != .identified)

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

test('native registration preflight rebinds changed inactive jobs and confirms identity only after readiness', { skip: process.platform !== 'darwin' }, async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'co2-background-preflight-'));
  try {
    const script = path.join(temporary, 'main.swift'), binary = path.join(temporary, 'fixture');
    await fs.writeFile(script, `import Foundation
import ServiceManagement
import Darwin

if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--ignore-term" {
    signal(SIGTERM, SIG_IGN)
    try Data(String(getpid()).utf8).write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
    while true { pause() }
}
let home = URL(fileURLWithPath: CommandLine.arguments[1]).resolvingSymlinksInPath()
let fm = FileManager.default
let runtime = home.appendingPathComponent(".coop")
try fm.createDirectory(at: runtime, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
func rejected(_ operation: () throws -> Void) { do { try operation(); preconditionFailure("Unsafe registration record accepted") } catch {} }
func wait(until condition: () -> Bool) {
    let end = Date().addingTimeInterval(3)
    while !condition() && Date() < end { RunLoop.current.run(until: Date().addingTimeInterval(0.01)) }
    precondition(condition(), "Synthetic command did not finish")
}

precondition(BackgroundJobState.parse(status: 113, output: "") == .missing)
precondition(BackgroundJobState.parse(status: 1, output: "") == .unavailable(.failed(1)))
precondition(BackgroundJobState.parse(status: 0, output: "job = {\\n\\tstate = running\\n\\tpid = 200\\n\\t\\tstate = active\\n}") == .running(200))
precondition(BackgroundJobState.parse(status: 0, output: "job = {\\n\\tstate = spawn scheduled\\n\\tjob state = spawn failed\\n\\tlast exit code = 78: EX_CONFIG\\n}") == .inactive(failed: true))
precondition(BackgroundJobState.parse(status: 0, output: "job = {\\n\\tstate = waiting\\n}") == .inactive(failed: false))
for output in ["", "\\tstate = running", "\\tstate = spawning", "\\tstate = waiting\\n\\tpid = unknown", "\\tstate = waiting\\n\\tpid = 123\\n\\tpid = 456", "\\tstate = spawning\\n\\tlast exit code = 78: EX_CONFIG\\n\\tjob state = spawn failed", "\\tstate = running\\n\\tlast exit reason = OS_REASON_CODESIGNING"] {
    precondition(BackgroundJobState.parse(status: 0, output: output) == .unavailable(.unverified))
}

func exercise(_ jobs: [BackgroundJobState], matches: Bool = false, allowManaged: Bool = true, status initial: SMAppService.Status = .enabled,
              stopResult: BackgroundStartResult = .started, unregistered: Bool = true,
              registerError: Bool = false, becomesApproval: Bool = false,
              cancelAt: String? = nil) -> ([String], BackgroundStartResult?, Int) {
    var events: [String] = [], result: BackgroundStartResult?, status = initial, index = 0, active = true, staged = 0
    BackgroundPreflightPolicy.start(identityMatches: matches, allowManaged: allowManaged, registration: { status }, shouldContinue: { active },
        inspect: { reply in events.append("inspect"); let job = jobs[min(index, jobs.count - 1)]; index += 1; if cancelAt == "inspect" { active = false }; reply(job) },
        bootout: { reply in events.append("bootout"); if cancelAt == "bootout" { active = false }; reply(stopResult) },
        unregister: { reply in events.append("unregister"); if unregistered { status = .notRegistered }; if cancelAt == "unregister" { active = false }; reply(unregistered) },
        register: { events.append("register"); status = becomesApproval ? .requiresApproval : .enabled; if registerError { throw NSError(domain: "Synthetic", code: 3) } },
        settle: { interval, action in events.append(interval > 10 ? "settle-failed-job" : "settle"); if cancelAt == "settle" { active = false }; action() },
        registered: { staged += 1; events.append("stage") },
        kickstart: { reply in events.append("kickstart"); if cancelAt == "kickstart" { active = false }; reply(.started) },
        completion: { value in precondition(result == nil, "Completed more than once"); result = value })
    return (events, result, staged)
}
let changed = exercise([.inactive(failed: false)])
precondition(changed.0 == ["inspect", "inspect", "bootout", "unregister", "settle", "register", "stage", "kickstart"] && changed.1 == .started && changed.2 == 1)
let failed = exercise([.inactive(failed: true)], matches: true)
precondition(failed.0 == ["inspect", "inspect", "bootout", "unregister", "settle-failed-job", "register", "stage", "kickstart"] && failed.1 == .started)
let missing = exercise([.missing], status: .notRegistered)
precondition(missing.0 == ["inspect", "inspect", "unregister", "settle", "register", "stage", "kickstart"] && missing.1 == .started)
let unchanged = exercise([.inactive(failed: false)], matches: true)
precondition(unchanged.0 == ["inspect", "kickstart"] && unchanged.1 == .started && unchanged.2 == 0)
// Missing identity is never permission to kill or bless an existing service.
let running = exercise([.running(200)])
precondition(running.0 == ["inspect"] && running.1 == .started && running.2 == 0)
let race = exercise([.inactive(failed: true), .running(201)])
precondition(race.0 == ["inspect", "inspect"] && race.1 == .started && race.2 == 0)
for failure: BackgroundStartResult in [.unverified, .timedOut, .launchFailed, .failed(5)] {
    let unknown = exercise([.unavailable(failure)])
    precondition(unknown.0 == ["inspect"] && unknown.1 == failure && unknown.2 == 0)
}
let denied = exercise([.missing], status: .requiresApproval)
precondition(denied.0 == ["inspect"] && denied.1 == .requiresApproval)
let bootoutFailed = exercise([.inactive(failed: true)], stopResult: .timedOut)
precondition(bootoutFailed.0 == ["inspect", "inspect", "bootout"] && bootoutFailed.1 == .timedOut && bootoutFailed.2 == 0)
let detachFailed = exercise([.missing], unregistered: false)
precondition(detachFailed.0 == ["inspect", "inspect", "unregister"] && detachFailed.1 == .registrationFailed)
let registerFailed = exercise([.missing], registerError: true)
precondition(registerFailed.1 == .registrationFailed && registerFailed.2 == 0 && !registerFailed.0.contains("kickstart"))
let approval = exercise([.missing], becomesApproval: true)
precondition(approval.1 == .requiresApproval && approval.2 == 0)
for boundary in ["inspect", "bootout", "unregister", "settle", "kickstart"] {
    let cancelled = exercise([.inactive(failed: true)], cancelAt: boundary)
    precondition(cancelled.1 == .cancelled)
    if boundary != "kickstart" { precondition(cancelled.2 == 0 && !cancelled.0.contains("register")) }
}

// Ad-hoc/unknown signing uses the same authenticated service if it is already
// alive, otherwise it removes only inactive system ownership before authorizing
// a GUI-owned foreground service. It never registers, kickstarts or stages.
let foreground = exercise([.inactive(failed: true)], allowManaged: false)
precondition(foreground.0 == ["inspect", "inspect", "bootout", "unregister"] && foreground.1 == .foreground && foreground.2 == 0)
let foregroundMissing = exercise([.missing], allowManaged: false, status: .notRegistered)
precondition(foregroundMissing.0 == ["inspect", "inspect", "unregister"] && foregroundMissing.1 == .foreground && foregroundMissing.2 == 0)
let foregroundWaiting = exercise([.inactive(failed: false)], matches: true, allowManaged: false)
precondition(foregroundWaiting.1 == .foreground && foregroundWaiting.0 == ["inspect", "inspect", "bootout", "unregister"])
let foregroundDenied = exercise([.missing], allowManaged: false, status: .requiresApproval)
precondition(foregroundDenied.1 == .foreground && foregroundDenied.2 == 0)
let foregroundRunning = exercise([.running(200)], allowManaged: false)
precondition(foregroundRunning.0 == ["inspect"] && foregroundRunning.1 == .started && foregroundRunning.2 == 0)
let foregroundRace = exercise([.inactive(failed: true), .running(201)], allowManaged: false)
precondition(foregroundRace.0 == ["inspect", "inspect"] && foregroundRace.1 == .started && foregroundRace.2 == 0)
let foregroundUnknown = exercise([.unavailable(.unverified)], allowManaged: false)
precondition(foregroundUnknown.1 == .unverified && foregroundUnknown.0 == ["inspect"])
let foregroundFailed = exercise([.inactive(failed: true)], allowManaged: false, unregistered: false)
precondition(foregroundFailed.1 == .registrationFailed && foregroundFailed.2 == 0)
for boundary in ["inspect", "bootout", "unregister"] {
    let cancelled = exercise([.inactive(failed: true)], allowManaged: false, cancelAt: boundary)
    precondition(cancelled.1 == .cancelled && cancelled.2 == 0 && !cancelled.0.contains("register") && !cancelled.0.contains("kickstart"))
}

// Exercise actual private fingerprint storage and readiness receipt without
// registering any service. The synthetic executable/plist are inert text.
let bundleURL = home.appendingPathComponent("Synthetic.app")
let executable = bundleURL.appendingPathComponent("Contents/MacOS/Synthetic")
let plist = bundleURL.appendingPathComponent("Contents/Library/LaunchAgents/" + BackgroundConfiguration.plistName)
try fm.createDirectory(at: executable.deletingLastPathComponent(), withIntermediateDirectories: true)
try fm.createDirectory(at: plist.deletingLastPathComponent(), withIntermediateDirectories: true)
try Data("synthetic executable one".utf8).write(to: executable)
try Data("synthetic launch configuration one".utf8).write(to: plist)
try Data("<?xml version=\\"1.0\\"?><plist version=\\"1.0\\"><dict><key>CFBundleIdentifier</key><string>local.codexco2.preflight.fixture</string><key>CFBundleExecutable</key><string>Synthetic</string></dict></plist>".utf8).write(to: bundleURL.appendingPathComponent("Contents/Info.plist"))
let bundle = Bundle(url: bundleURL)!
let original = try BackgroundRegistrationIdentity.capture(bundle: bundle)
let file = runtime.appendingPathComponent(BackgroundRegistrationIdentity.fileName)
let receipt = BackgroundRegistrationReceipt()
try receipt.confirmReady(runtime: runtime) { original }
precondition(!fm.fileExists(atPath: file.path))
receipt.stage(runtime: runtime, identity: original)
precondition(!fm.fileExists(atPath: file.path), "register success must not write a ready receipt")
try receipt.confirmReady(runtime: home.appendingPathComponent("different/.coop")) { original }
precondition(!fm.fileExists(atPath: file.path))
try receipt.confirmReady(runtime: runtime) { original }
precondition(try! BackgroundRegistrationIdentity.read(runtime: runtime) == original)
let permissions = try fm.attributesOfItem(atPath: file.path)[.posixPermissions] as! NSNumber
precondition(permissions.intValue == 0o600)
try Data("synthetic executable two".utf8).write(to: executable)
let replaced = try BackgroundRegistrationIdentity.capture(bundle: bundle)
precondition(replaced != original)
receipt.stage(runtime: runtime, identity: original)
rejected { try receipt.confirmReady(runtime: runtime) { replaced } }
precondition(try! BackgroundRegistrationIdentity.read(runtime: runtime) == original)
receipt.stage(runtime: runtime, identity: replaced); receipt.clear()
try receipt.confirmReady(runtime: runtime) { replaced }
precondition(try! BackgroundRegistrationIdentity.read(runtime: runtime) == original)
try Data("synthetic launch configuration two".utf8).write(to: plist)
precondition(try! BackgroundRegistrationIdentity.capture(bundle: bundle) != replaced)
try fm.setAttributes([.posixPermissions: 0o644], ofItemAtPath: file.path)
rejected { _ = try BackgroundRegistrationIdentity.read(runtime: runtime) }
rejected { try original.save(runtime: runtime) }
try fm.removeItem(at: file)
try fm.createSymbolicLink(at: file, withDestinationURL: home.appendingPathComponent("outside"))
rejected { try original.save(runtime: runtime) }
try fm.removeItem(at: file)

// Bounded command runner distinguishes a genuine exit code from timeout or
// spawn failure; no launchctl mutation is invoked by this test.
var commandResults: [String] = []
BackgroundCommand.run(arguments: ["-c", "printf synthetic; exit 7"], executable: URL(fileURLWithPath: "/bin/sh")) { result in
    if case .exited(7, "synthetic") = result { commandResults.append("exit") } else { preconditionFailure("Lost real exit status") }
}
wait { commandResults.count == 1 }
BackgroundCommand.run(arguments: [], executable: home.appendingPathComponent("does-not-exist")) { result in
    if case .launchFailed = result { commandResults.append("spawn") } else { preconditionFailure("Lost spawn failure") }
}
wait { commandResults.count == 2 }
BackgroundCommand.run(arguments: ["2"], executable: URL(fileURLWithPath: "/bin/sleep"), timeout: 0.05) { result in
    if case .timedOut = result { commandResults.append("timeout") } else { preconditionFailure("Timeout was reported as an exit code") }
}
wait { commandResults.count == 3 }
RunLoop.current.run(until: Date().addingTimeInterval(0.15))
precondition(commandResults == ["exit", "spawn", "timeout"])
let pidFile = runtime.appendingPathComponent("synthetic-command.pid")
BackgroundCommand.run(arguments: ["--ignore-term", pidFile.path], executable: URL(fileURLWithPath: CommandLine.arguments[0]), timeout: 1) { result in
    if case .timedOut = result {
        let pid = Int32(try! String(contentsOf: pidFile, encoding: .utf8))!
        precondition(kill(pid, 0) == -1 && errno == ESRCH, "Timeout settled before the owned command exited")
        commandResults.append("resistant")
    } else { preconditionFailure("Lost terminated timeout") }
}
wait { commandResults.count == 4 }
print("native background preflight passed")
`);
    execFileSync('/usr/bin/swiftc', ['-framework', 'AppKit', '-framework', 'ServiceManagement',
      path.join(root, 'macos/BackgroundService.swift'), script, '-o', binary], { stdio: 'pipe', timeout: 30000 });
    assert.equal(execFileSync(binary, [temporary], { encoding: 'utf8', timeout: 10000,
      env: { HOME: temporary, PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' } }).trim(), 'native background preflight passed');
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});
