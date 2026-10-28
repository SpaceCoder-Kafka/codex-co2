import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));

test('native startup repairs missing registrations once, reports failures, and preserves service ownership on retry', { skip: process.platform !== 'darwin' }, async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'co2-native-startup-'));
  try {
    const app = path.join(temporary, 'Fixture.app'), resources = path.join(app, 'Contents/Resources');
    const runtime = path.join(temporary, '.coop'), binary = path.join(app, 'Contents/MacOS/Fixture');
    await fs.mkdir(path.dirname(binary), { recursive: true });
    await fs.mkdir(path.join(resources, 'runtime'), { recursive: true });
    await fs.mkdir(runtime, { mode: 0o700 });
    await fs.writeFile(path.join(app, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.codexco2.startup.fixture</string>
<key>CFBundleExecutable</key><string>Fixture</string></dict></plist>`);
    // This shell is the complete synthetic service. No installed Codex, real
    // runtime, user index, launch registration, network or credentials are used.
    await fs.writeFile(path.join(resources, 'runtime/node'), `#!/bin/sh
mode=$2
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--runtime-dir" ]; then shift; runtime=$1; break; fi
  shift
done
scenario=$(/bin/cat "$runtime/fixture-mode")
if [ "$mode" = "--daemon" ]; then
  if [ "$scenario" = "dead" ] || [ "$scenario" = "winner" ]; then exit 23; fi
  if [ "$scenario" = "winner-first" ]; then /bin/sleep 0.4; exit 23; fi
  exec /bin/sleep 30
fi
if [ "$scenario" = "winner" ] || [ "$scenario" = "winner-first" ]; then
  if [ "$scenario" = "winner" ]; then /bin/sleep 0.2; fi
  printf '%s\\n' '{"type":"background-state","enabled":true,"background":true}' '{"type":"ready","ownerUrl":"http://127.0.0.1:12345/"}'
  while IFS= read -r line; do :; done
fi
if [ "$scenario" = "retrying" ]; then exit 7; fi
if [ "$scenario" != "ready" ]; then exec /bin/sleep 30; fi
printf '%s\\n' '{"type":"background-state","enabled":false,"background":false}' '{"type":"ready","ownerUrl":"http://127.0.0.1:12345/"}'
while IFS= read -r line; do :; done
`, { mode: 0o755 });
    const source = await fs.readFile(path.join(root, 'macos/App.swift'), 'utf8');
    // Compile the production delegate, replacing only the page-load boundary
    // so a synthetic ready event cannot open a real manager or fetch an index.
    assert.equal(source.split('webView.load(URLRequest(url: url))').length, 2);
    await fs.writeFile(path.join(temporary, 'App.swift'), source.slice(0, source.indexOf('@main\n'))
      .replace('webView.load(URLRequest(url: url))', 'precondition(url.host == "127.0.0.1")'));
    const background = await fs.readFile(path.join(root, 'macos/BackgroundService.swift'), 'utf8');
    await fs.writeFile(path.join(temporary, 'Background.swift'), background.replaceAll('FileManager.default.homeDirectoryForCurrentUser',
      'URL(fileURLWithPath: ProcessInfo.processInfo.environment["HOME"]!)'));
    await fs.writeFile(path.join(temporary, 'Updates.swift'), `import AppKit
// Update/network/installation behavior belongs to its own tests.
enum UpdatePreparationResult { case ready, cancelled, failed }
struct UpdatePolicy { static func link(_ name: String) -> URL? { nil } }
final class AppUpdates {
 var installationAuthorized = false
 var preventsTermination = false
 var appInfo: [String: Any] = [:]
 var state: [String: Any] = [:]
 var localize: (String) -> String = { $0 }
 var stateDidChange: (() -> Void)?
 var showAbout: (() -> Bool)?
 var prepareInstallation: ((@escaping (UpdatePreparationResult) -> Void) -> Void)?
 func start() {}
 func check() {}
 func cancel() {}
 func handle(_ body: [String: Any]) {}
}
`);
    await fs.writeFile(path.join(temporary, 'main.swift'), `import AppKit
let application = NSApplication.shared
let runtime = URL(fileURLWithPath: CommandLine.arguments[2])
func wait(_ seconds: TimeInterval = 3, until condition: () -> Bool) {
    let end = Date().addingTimeInterval(seconds)
    while !condition() && Date() < end { RunLoop.current.run(until: Date().addingTimeInterval(0.01)) }
    precondition(condition(), "Timed out waiting for synthetic startup state")
}
func tick(_ seconds: TimeInterval) { RunLoop.current.run(until: Date().addingTimeInterval(seconds)) }
func scenario(_ name: String) { try! Data(name.utf8).write(to: runtime.appendingPathComponent("fixture-mode")) }
func manager(timeout: TimeInterval) -> AppDelegate {
    let delegate = AppDelegate()
    delegate.startupTimeout = timeout
    delegate.statusLabel = NSTextField(labelWithString: "")
    delegate.startupExplanation = NSTextField(labelWithString: "")
    delegate.startupPanel = NSStackView()
    delegate.startupRetry = NSButton()
    return delegate
}
func cleanup(_ delegate: AppDelegate) {
    delegate.serviceStopRequested = true; delegate.startupAttempt = nil
    if delegate.helper?.isRunning == true { delegate.helper?.terminate() }
    if delegate.foregroundDaemon?.isRunning == true { delegate.foregroundDaemon?.terminate() }
    wait { delegate.helper == nil && delegate.foregroundDaemon == nil }
}
// Only a positive missing-job result permits one registration repair. Other
// failures must remain visible without creating a replacement foreground job.
func policy(_ responses: [BackgroundStartResult], repairOK: Bool = true,
            kicks expectedKicks: Int, repairs expectedRepairs: Int, result expected: BackgroundStartResult) {
    var queue = responses, kicks = 0, repairs = 0, results: [BackgroundStartResult] = []
    BackgroundLaunchPolicy.start(shouldContinue: { true }, kickstart: { completion in
        kicks += 1; precondition(!queue.isEmpty); completion(queue.removeFirst())
    }, repair: { completion in repairs += 1; completion(repairOK) }, completion: { results.append($0) })
    precondition(kicks == expectedKicks && repairs == expectedRepairs && results == [expected])
}
policy([.started], kicks: 1, repairs: 0, result: .started)
policy([.missing, .started], kicks: 2, repairs: 1, result: .started)
policy([.missing], repairOK: false, kicks: 1, repairs: 1, result: .missing)
policy([.missing, .missing], kicks: 2, repairs: 1, result: .missing)
policy([.failed(5)], kicks: 1, repairs: 0, result: .failed(5))
for cancelStage in ["kickstart", "repair", "retry"] {
    var active = true, kicks = 0, repairs = 0, results: [BackgroundStartResult] = []
    var kickReply: ((BackgroundStartResult) -> Void)?, repairReply: ((Bool) -> Void)?
    BackgroundLaunchPolicy.start(shouldContinue: { active }, kickstart: { completion in
        kicks += 1; kickReply = completion
    }, repair: { completion in repairs += 1; repairReply = completion }, completion: { results.append($0) })
    if cancelStage == "kickstart" {
        active = false; kickReply?(.missing)
        precondition(kicks == 1 && repairs == 0)
    } else {
        kickReply?(.missing)
        if cancelStage == "repair" {
            active = false; repairReply?(true)
            precondition(kicks == 1 && repairs == 1)
        } else {
            repairReply?(true); active = false; kickReply?(.started)
            precondition(kicks == 2 && repairs == 1)
        }
    }
    precondition(results == [.cancelled])
}

// The actual manager never substitutes a foreground daemon for a failed
// managed service, and ignores results belonging to an older launch attempt.
for result: BackgroundStartResult in [.missing, .failed(5), .timedOut, .launchFailed, .unverified, .registrationFailed, .requiresApproval] {
    let managed = manager(timeout: 5)
    managed.activeRuntime = runtime; managed.usingManagedService = true; managed.managedStartupRequired = true; managed.beginStartup()
    let attempt = managed.startupAttempt!; managed.managedStartAttempt = attempt
    managed.finishManagedStart(result, attempt: attempt)
    precondition(managed.startupFailure != nil && managed.foregroundDaemon == nil && managed.helper == nil)
    precondition(!managed.startupPanel!.isHidden)
    if result != .failed(5) {
        precondition(!managed.startupExplanation!.stringValue.contains("-1"))
        precondition(!managed.startupExplanation!.stringValue.contains("退出代码"))
    }
    managed.finishManagedStart(.started, attempt: attempt)
    precondition(managed.foregroundDaemon == nil && managed.helper == nil)
    cleanup(managed)
}
// A known unavailable background service may use foreground ownership even
// when recovery must be preserved; the shared service owns that persistence.
scenario("ready")
let approval = manager(timeout: 5)
approval.activeRuntime = runtime; approval.usingManagedService = true; approval.managedStartupRequired = true; approval.beginStartup()
approval.managedStartAttempt = approval.startupAttempt
approval.finishManagedStart(.foreground, attempt: approval.startupAttempt!)
wait { approval.ownerURL != nil }
precondition(!approval.usingManagedService && approval.foregroundDaemon?.isRunning == true)
cleanup(approval)
scenario("ready")
let existingService = Process()
existingService.executableURL = URL(fileURLWithPath: "/bin/sleep"); existingService.arguments = ["30"]
try! existingService.run()
let managed = manager(timeout: 5)
managed.activeRuntime = runtime; managed.usingManagedService = true; managed.managedStartupRequired = true; managed.beginStartup()
managed.managedStartAttempt = managed.startupAttempt
managed.finishManagedStart(.started, attempt: managed.startupAttempt!)
wait { managed.ownerURL != nil }
precondition(managed.foregroundDaemon == nil && existingService.isRunning)
cleanup(managed)
precondition(existingService.isRunning)
existingService.terminate(); existingService.waitUntilExit()

// A timeout displays an error but cannot allow a second registration
// transaction before the cancelled asynchronous operation settles.
let pending = manager(timeout: 0.05)
pending.activeRuntime = runtime; pending.usingManagedService = true; pending.managedStartupRequired = true
pending.beginStartup()
let pendingAttempt = pending.startupAttempt!; pending.managedStartAttempt = pendingAttempt
wait { pending.startupFailure != nil }
let timeoutFailure = pending.startupFailure
precondition(pending.startupAttempt == nil && pending.managedStartAttempt == pendingAttempt)
precondition(!pending.startupRetry!.isEnabled)
pending.retry()
precondition(pending.managedStartAttempt == pendingAttempt && pending.helper == nil && pending.foregroundDaemon == nil)
precondition(pending.startupFailure == timeoutFailure)
pending.finishManagedStart(.cancelled, attempt: pendingAttempt)
precondition(pending.managedStartAttempt == nil && pending.startupRetry!.isEnabled)
scenario("ready")
pending.retry()
wait { pending.ownerURL != nil }
precondition(pending.startupFailure == nil && pending.foregroundDaemon?.isRunning == true)
cleanup(pending)

// Failed managed startup, retry, and a fresh app launch all preserve a
// checkpoint even when its contents are not valid JSON. Native fallback must
// leave storage decisions to the service instead of deleting recovery state.
let checkpoint = runtime.appendingPathComponent("lan-invite-recovery.json")
let sentinel = Data("synthetic recovery sentinel; must not be read as JSON".utf8)
try! sentinel.write(to: checkpoint)
for inheritedRequirement in [true, false] {
    let failed = manager(timeout: 5)
    failed.activeRuntime = runtime; failed.usingManagedService = true
    failed.managedStartupRequired = inheritedRequirement
    if inheritedRequirement {
        failed.beginStartup(); failed.managedStartAttempt = failed.startupAttempt
        failed.finishManagedStart(.missing, attempt: failed.startupAttempt!)
        precondition(failed.startupFailure != nil)
    }
    failed.retry()
    wait { failed.ownerURL != nil }
    precondition(failed.foregroundDaemon?.isRunning == true)
    precondition(failed.startupFailure == nil && (try! Data(contentsOf: checkpoint)) == sentinel)
    cleanup(failed)
}
try! FileManager.default.removeItem(at: checkpoint)

// Update preparation must fail while registration is pending; a missing
// control bridge is not proof that the managed service has stopped.
let stopping = manager(timeout: 5)
stopping.usingManagedService = true; stopping.managedStartupRequired = true; stopping.beginStartup()
let stoppingAttempt = stopping.startupAttempt!; stopping.managedStartAttempt = stoppingAttempt
var stopped: Bool?
stopping.beginHelperShutdown(forceOnTimeout: false) { stopped = $0 }
precondition(stopped == false && stopping.startupAttempt == nil && stopping.serviceStopRequested)
precondition(stopping.managedStartAttempt == stoppingAttempt && !stopping.serviceStoppedConfirmed)
stopping.finishManagedStart(.cancelled, attempt: stoppingAttempt)
cleanup(stopping)

// Quitting during registration cancels later repair without blocking the GUI
// or pretending that an independent service has stopped.
let quitting = manager(timeout: 5)
quitting.usingManagedService = true; quitting.managedStartupRequired = true; quitting.beginStartup()
let quittingAttempt = quitting.startupAttempt!; quitting.managedStartAttempt = quittingAttempt
var pendingKick: ((BackgroundStartResult) -> Void)?, quitRepairs = 0
BackgroundLaunchPolicy.start(shouldContinue: {
    quitting.startupAttempt == quittingAttempt && !quitting.exiting && !quitting.serviceStopRequested
}, kickstart: { pendingKick = $0 }, repair: { completion in quitRepairs += 1; completion(true) }, completion: {
    quitting.finishManagedStart($0, attempt: quittingAttempt)
})
precondition(quitting.applicationShouldTerminate(application) == .terminateNow)
precondition(quitting.exiting && quitting.serviceStopRequested && quitting.startupAttempt == nil)
precondition(!quitting.serviceStoppedConfirmed)
pendingKick?(.missing)
precondition(quitRepairs == 0 && quitting.managedStartAttempt == nil && quitting.helper == nil && quitting.foregroundDaemon == nil)
precondition(quitting.startupFailure == nil)
cleanup(quitting)

// A foreground daemon that exits is reported promptly instead of retrying a
// nonexistent service for the full 40-attempt window. Only exit metadata appears.
scenario("dead")
let dead = manager(timeout: 5)
dead.launchHelper()
wait { dead.startupFailure != nil && dead.helper == nil }
precondition(dead.startupExplanation!.stringValue.contains("23"))
precondition(dead.startupPanel!.isHidden == false && dead.startupRetry!.isEnabled)
precondition(dead.bridgeLaunchAttempts <= 1)
cleanup(dead)

// A lease loser must not kill the bridge that authenticates a legitimate
// existing winner. Shutdown behavior follows the authenticated service state.
for ordering in ["winner", "winner-first"] {
    scenario(ordering)
    let winner = manager(timeout: 5)
    winner.launchHelper()
    wait { winner.ownerURL != nil && winner.foregroundDaemon == nil }
    tick(1.1)
    precondition(winner.startupFailure == nil && winner.helper?.isRunning == true)
    precondition(winner.backgroundActive && winner.usingManagedService)
    precondition(winner.applicationShouldTerminate(application) == .terminateNow)
    cleanup(winner)
}

// A live, silent helper has a bounded wait. Killing its management connection
// must not kill an independently owned service or create another daemon.
scenario("silent")
let silent = manager(timeout: 0.3)
silent.launchHelper()
let daemon = silent.foregroundDaemon!
wait { silent.startupFailure != nil && silent.helper == nil }
precondition(daemon.isRunning && silent.foregroundDaemon === daemon)
precondition(silent.startupPanel!.isHidden == false)
// A ready message already queued by the timed-out bridge must not erase the
// failure or navigate after that bridge has been selected for termination.
silent.receive(["type": "ready", "ownerUrl": "http://127.0.0.1:12345/"])
precondition(silent.startupFailure != nil && silent.ownerURL == nil && !silent.startupPanel!.isHidden)
scenario("ready")
silent.retry()
wait { silent.ownerURL != nil }
precondition(silent.foregroundDaemon === daemon)
precondition(silent.startupFailure == nil && silent.startupPanel!.isHidden)
// A timeout queued for the old attempt cannot overwrite this successful retry.
tick(0.4)
precondition(silent.startupFailure == nil && silent.ownerURL != nil)
// A late exit callback from a superseded daemon cannot affect the current one.
silent.didStopForeground(Process())
precondition(silent.foregroundDaemon === daemon && silent.startupFailure == nil)
cleanup(silent)

// Repeated bridge failures keep the original deadline instead of extending it.
scenario("retrying")
let retrying = manager(timeout: 0.7)
retrying.launchHelper()
let attempt = retrying.startupAttempt
wait { retrying.bridgeLaunchAttempts >= 2 }
precondition(retrying.startupAttempt == attempt)
wait { retrying.startupFailure != nil && retrying.helper == nil }
let attempts = retrying.bridgeLaunchAttempts
tick(0.4)
precondition(retrying.bridgeLaunchAttempts == attempts)
cleanup(retrying)
print("native startup lifecycle passed")
`);
    execFileSync('/usr/bin/swiftc', ['-framework', 'AppKit', '-framework', 'WebKit', '-framework', 'ServiceManagement',
      ...['App.swift', 'Background.swift', 'Updates.swift', 'main.swift'].map(name => path.join(temporary, name)), '-o', binary],
    { stdio: 'pipe', timeout: 30000 });
    assert.equal(execFileSync(binary, ['--runtime-dir', runtime], { encoding: 'utf8', timeout: 15000,
      env: { HOME: temporary, PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' } }).trim(), 'native startup lifecycle passed');
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});
