import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const sourceFile = fileURLToPath(new URL('../macos/Updater.swift', import.meta.url));

test('native update policy restricts capabilities, channels and checks; preparation completes once', { skip: process.platform !== 'darwin' }, async () => {
  const source = await fs.readFile(sourceFile, 'utf8');
  const policy = source.slice(source.indexOf('struct UpdatePolicy {'), source.indexOf('final class AppUpdates:'));
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'co2-update-policy-'));
  try {
    const script = path.join(temporary, 'main.swift');
    await fs.writeFile(script, 'import Foundation\n' + policy + `
precondition(UpdatePolicy.action(["action": "install"]) == "install")
precondition(UpdatePolicy.action(["action": "openLink", "link": "repository"]) == "openLink")
precondition(UpdatePolicy.action(["action": "install", "path": "/tmp/untrusted"]) == nil)
precondition(UpdatePolicy.action(["action": "openLink", "link": "https://example.test"]) == nil)
precondition(UpdatePolicy.action(["action": "shell"]) == nil)
precondition(UpdatePolicy.action(["action": 1]) == nil)
precondition(UpdatePolicy.link("releases")?.absoluteString == UpdatePolicy.repository + "/releases")
precondition(UpdatePolicy.link("unknown") == nil)
precondition(UpdatePolicy.channels("preview") == ["preview"])
precondition(UpdatePolicy.channels("stable").isEmpty)
let now = Date(timeIntervalSince1970: 200000)
precondition(UpdatePolicy.isDue(lastCheck: nil, now: now))
precondition(!UpdatePolicy.isDue(lastCheck: now, now: now))
precondition(!UpdatePolicy.isDue(lastCheck: now.addingTimeInterval(1000), now: now))
precondition(!UpdatePolicy.isDue(lastCheck: now.addingTimeInterval(-86399), now: now))
precondition(UpdatePolicy.isDue(lastCheck: now.addingTimeInterval(-86400), now: now))
precondition(UpdatePolicy.allowsFeed(UpdatePolicy.feed, testing: false))
precondition(!UpdatePolicy.allowsFeed("http://127.0.0.1:12345/appcast.xml", testing: false))
precondition(UpdatePolicy.allowsFeed("http://127.0.0.1:12345/appcast.xml", testing: true))
precondition(!UpdatePolicy.allowsFeed("https://example.test/appcast.xml", testing: true))
precondition(UpdatePolicy.allowsArchive(URL(string: UpdatePolicy.repository + "/releases/download/v0.3.3-preview.14/update.dmg"), testing: false))
precondition(!UpdatePolicy.allowsArchive(URL(string: "https://github.com/other/repo/releases/download/v1/update.dmg"), testing: false))
precondition(!UpdatePolicy.allowsArchive(URL(string: "https://github.com.evil.test/SpaceCoder-Kafka/codex-co2/releases/download/v1/update.dmg"), testing: false))
precondition(!UpdatePolicy.allowsArchive(URL(string: "https:" + "//user:pass@github.com/SpaceCoder-Kafka/codex-co2/releases/download/v1/update.dmg"), testing: false))
precondition(!UpdatePolicy.allowsArchive(URL(string: "file:///tmp/update.dmg"), testing: true))
precondition(!UpdatePolicy.allowsArchive(URL(string: UpdatePolicy.repository + "/releases/download/v1/update.zip"), testing: false))
precondition(!UpdatePolicy.validKey(nil))
precondition(!UpdatePolicy.validKey("invalid"))
precondition(!UpdatePolicy.validKey(Data(repeating: 0, count: 31).base64EncodedString()))
precondition(UpdatePolicy.validKey(Data(repeating: 0, count: 32).base64EncodedString()))

let gate = UpdateInstallationGate()
var pending: ((UpdatePreparationResult) -> Void)?
var outcomes: [UpdatePreparationResult] = []
precondition(gate.begin(prepare: { pending = $0 }, completion: { outcomes.append($0) }))
precondition(gate.isPreparing)
precondition(!gate.begin(prepare: { _ in fatalError("duplicate preparation") }, completion: { _ in }))
gate.cancel()
precondition(!gate.isPreparing && outcomes == [.cancelled])
pending?(.ready)
precondition(outcomes == [.cancelled])
precondition(gate.begin(prepare: { pending = $0 }, completion: { outcomes.append($0) }))
pending?(.failed); pending?(.ready)
precondition(outcomes == [.cancelled, .failed])
precondition(gate.begin(prepare: { $0(.ready) }, completion: { outcomes.append($0) }))
precondition(outcomes == [.cancelled, .failed, .ready] && !gate.isPreparing)
print("update policy passed")
`);
    assert.equal(execFileSync('/usr/bin/swift', [script], { encoding: 'utf8', timeout: 30000, env: { ...process.env, HOME: temporary } }).trim(), 'update policy passed');
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});

test('actual native update driver cancels extraction and shutdown races before authorizing installation', { skip: process.platform !== 'darwin' }, async t => {
  // This links the actual implementation and official framework, but substitutes
  // its session entrypoints. It starts no app, network request or installer.
  const framework = process.env.CO2_TEST_SPARKLE_FRAMEWORK
    ?? fileURLToPath(new URL('../.coop/build-cache/Sparkle-2.10.0/Sparkle.framework', import.meta.url));
  try { await fs.access(path.join(framework, 'Sparkle')); }
  catch { t.skip('Official Sparkle framework unavailable; build:macos prepares it, or set CO2_TEST_SPARKLE_FRAMEWORK'); return; }
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'co2-update-driver-'));
  try {
    const app = path.join(temporary, 'Fixture.app');
    await fs.mkdir(path.join(app, 'Contents'), { recursive: true });
    await fs.writeFile(path.join(app, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>local.codexco2.update.fixture</string>
<key>CFBundleVersion</key><string>13</string><key>CFBundleShortVersionString</key><string>0.3.3</string>
<key>CFBundleName</key><string>Fixture</string><key>Co2UpdateChannel</key><string>preview</string>
<key>Co2UpdateTesting</key><true/><key>SUFeedURL</key><string>http://127.0.0.1:12345/appcast.xml</string>
<key>SUPublicEDKey</key><string>AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=</string>
<key>SURequireSignedFeed</key><true/><key>SUVerifyUpdateBeforeExtraction</key><true/>
<key>SUAllowsAutomaticUpdates</key><false/><key>SUEnableAutomaticChecks</key><false/>
</dict></plist>`);
    const script = path.join(temporary, 'main.swift');
    await fs.writeFile(script, `import Foundation
import Sparkle

final class MemoryDefaults: UserDefaults {
    var values: [String: Any] = [:]
    override func bool(forKey key: String) -> Bool { values[key] as? Bool ?? false }
    override func set(_ value: Any?, forKey key: String) { values[key] = value }
}
final class FixtureUpdater: SPUUpdater {
    var checks = 0
    override func start() throws {}
    override var sessionInProgress: Bool { false }
    override var automaticallyChecksForUpdates: Bool { get { false } set {} }
    override var sendsSystemProfile: Bool { get { false } set {} }
    override var lastUpdateCheckDate: Date? { nil }
    override func checkForUpdates() { checks += 1 }
}
let bundle = Bundle(path: CommandLine.arguments[1])!
let memory = MemoryDefaults()
var session: FixtureUpdater?
let driver = AppUpdates(bundle: bundle, defaults: memory, makeUpdater: { bundle, driver in
    let instance = FixtureUpdater(hostBundle: bundle, applicationBundle: bundle, userDriver: driver, delegate: driver)
    session = instance; return instance
})
driver.showAbout = { true }
var notifications = 0
driver.stateDidChange = { notifications += 1 }
driver.start()
precondition(driver.appInfo["version"] as? String == "0.3.3")
precondition(driver.appInfo["build"] as? String == "13")
precondition(driver.appInfo["canUpdate"] as? Bool == true)
driver.handle(["action": "dismissStar"])
precondition(memory.values["co2StarDismissed"] as? Bool == true)
precondition(driver.appInfo["starDismissed"] as? Bool == true)
let beforeInvalid = notifications
driver.handle(["action": "install", "path": "untrusted"])
precondition(beforeInvalid == notifications && session!.checks == 0)
driver.handle(["action": "check"])
precondition(session!.checks == 1)
driver.install()
precondition(session!.checks == 2)
var downloadCancellations = 0
driver.showDownloadInitiated(cancellation: { downloadCancellations += 1 })
driver.showDownloadDidReceiveExpectedContentLength(100)
driver.showDownloadDidReceiveData(ofLength: 40)
precondition(driver.state["progress"] as? Double == 0.4)
driver.cancel()
precondition(downloadCancellations == 1)
precondition(driver.state["phase"] as? String == "idle")
precondition(!driver.installationAuthorized)

// Once extraction starts there is no public cancellation handle. Cancelling
// must answer .skip at ready, never dismiss a task that could install on quit.
driver.install()
driver.showDownloadDidStartExtractingUpdate()
driver.cancel()
precondition(driver.preventsTermination)
var choices: [SPUUserUpdateChoice] = []
driver.showReady(toInstallAndRelaunch: { choices.append($0) })
precondition(choices == [.skip] && !driver.installationAuthorized)

// A late successful shutdown cannot revive a cancelled installation.
var preparation: ((UpdatePreparationResult) -> Void)?
driver.prepareInstallation = { preparation = $0 }
driver.install()
driver.showReady(toInstallAndRelaunch: { choices.append($0) })
precondition(driver.preventsTermination && choices == [.skip])
driver.cancel(); preparation?(.ready)
precondition(choices == [.skip, .skip] && !driver.installationAuthorized)

// A failed/timed-out helper shutdown leaves the old application in place.
driver.install()
driver.showReady(toInstallAndRelaunch: { choices.append($0) })
preparation?(.failed)
precondition(choices == [.skip, .skip, .skip])
precondition(driver.state["phase"] as? String == "error" && !driver.installationAuthorized)

// Installation is authorized only after the actual shutdown completion.
driver.install()
driver.showReady(toInstallAndRelaunch: { choices.append($0) })
precondition(!driver.installationAuthorized)
preparation?(.ready); preparation?(.ready)
precondition(choices == [.skip, .skip, .skip, .install])
precondition(driver.installationAuthorized && !driver.preventsTermination)
precondition(driver.state["phase"] as? String == "installing")

let noUpdate = NSError(domain: SUSparkleErrorDomain, code: Int(SUError.noUpdateError.rawValue), userInfo: [SPUNoUpdateFoundReasonKey: SPUNoUpdateFoundReason.onLatestVersion.rawValue])
var acknowledged = false
driver.showUpdateNotFoundWithError(noUpdate) { acknowledged = true }
precondition(acknowledged && driver.state["phase"] as? String == "upToDate")
let incompatible = NSError(domain: SUSparkleErrorDomain, code: Int(SUError.noUpdateError.rawValue), userInfo: [SPUNoUpdateFoundReasonKey: SPUNoUpdateFoundReason.systemIsTooOld.rawValue])
driver.showUpdateNotFoundWithError(incompatible) {}
precondition(driver.state["phase"] as? String == "error")
let emptyFeed = NSError(domain: SUSparkleErrorDomain, code: Int(SUError.noUpdateError.rawValue))
driver.showUpdateNotFoundWithError(emptyFeed) {}
precondition(driver.state["phase"] as? String == "error")
print("native update driver passed")
`);
    const executable = path.join(temporary, 'fixture');
    const frameworks = path.dirname(framework);
    execFileSync('/usr/bin/swiftc', ['-F', frameworks, '-framework', 'Sparkle', '-Xlinker', '-rpath', '-Xlinker', frameworks, sourceFile, script, '-o', executable], { encoding: 'utf8', timeout: 30000 });
    assert.equal(execFileSync(executable, [app], { encoding: 'utf8', timeout: 30000, env: { ...process.env, HOME: temporary } }).trim(), 'native update driver passed');
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});
