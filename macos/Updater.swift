import AppKit
import Sparkle

// These decisions are independent of WebKit and Sparkle's installer, so tests
// can exercise the production boundary without launching the user's app.
struct UpdatePolicy {
    static let repository = "https://github.com/SpaceCoder-Kafka/codex-co2"
    static let feed = "https://raw.githubusercontent.com/SpaceCoder-Kafka/codex-co2/updates/appcast.xml"
    static let interval: TimeInterval = 86400

    static func action(_ object: [String: Any]) -> String? {
        guard let action = object["action"] as? String else { return nil }
        if action == "openLink" {
            guard Set(object.keys) == ["action", "link"], let link = object["link"] as? String,
                  ["repository", "releases"].contains(link) else { return nil }
            return action
        }
        guard object.count == 1, ["info", "check", "install", "cancel", "dismissStar"].contains(action) else { return nil }
        return action
    }
    static func link(_ identifier: String) -> URL? {
        if identifier == "repository" { return URL(string: repository) }
        if identifier == "releases" { return URL(string: repository + "/releases") }
        return nil
    }
    static func channels(_ channel: String) -> Set<String> { channel == "preview" ? ["preview"] : [] }
    static func isDue(lastCheck: Date?, now: Date) -> Bool {
        guard let lastCheck = lastCheck else { return true }
        return now.timeIntervalSince(lastCheck) >= interval
    }
    static func allowsFeed(_ raw: String, testing: Bool) -> Bool {
        if raw == feed { return true }
        guard testing, let url = URL(string: raw) else { return false }
        return ["http", "https"].contains(url.scheme ?? "") && url.host == "127.0.0.1"
            && url.user == nil && url.password == nil && url.fragment == nil
    }
    static func allowsArchive(_ url: URL?, testing: Bool) -> Bool {
        guard let url = url, url.user == nil, url.password == nil, url.fragment == nil,
              url.pathExtension.lowercased() == "dmg" else { return false }
        if testing && url.host == "127.0.0.1" { return ["http", "https"].contains(url.scheme ?? "") }
        return url.scheme == "https" && url.host == "github.com"
            && url.path.hasPrefix("/SpaceCoder-Kafka/codex-co2/releases/download/")
    }
    static func validKey(_ raw: String?) -> Bool {
        guard let raw = raw, let bytes = Data(base64Encoded: raw) else { return false }
        return bytes.count == 32
    }
}

enum UpdatePreparationResult { case ready, cancelled, failed }

final class UpdateInstallationGate {
    private var token: UUID?
    private var completion: ((UpdatePreparationResult) -> Void)?
    var isPreparing: Bool { token != nil }

    @discardableResult func begin(prepare: (@escaping (UpdatePreparationResult) -> Void) -> Void,
                                 completion: @escaping (UpdatePreparationResult) -> Void) -> Bool {
        guard token == nil else { return false }
        let current = UUID(); token = current; self.completion = completion
        prepare { [weak self] result in
            guard let self = self, self.token == current else { return }
            self.finish(result)
        }
        return true
    }
    func cancel() { if token != nil { finish(.cancelled) } }
    private func finish(_ result: UpdatePreparationResult) {
        token = nil; let callback = completion; completion = nil; callback?(result)
    }
}

final class AppUpdates: NSObject, SPUUserDriver, SPUUpdaterDelegate {
    private let bundle: Bundle
    private let defaults: UserDefaults
    private let makeUpdater: ((Bundle, AppUpdates) -> SPUUpdater)?
    private var updater: SPUUpdater?
    private let gate = UpdateInstallationGate()
    private var cancellation: (() -> Void)?
    private var installRequested = false
    private var cancelRequested = false
    private var nativePresentationPending = false
    private var userInitiated = false
    private var expectedBytes: UInt64 = 0
    private var receivedBytes: UInt64 = 0
    private var lastChecked: Date?
    private var lastProgressNotification = Date.distantPast
    private var progressNotificationPending = false
    private var candidate: SUAppcastItem?
    private(set) var installationAuthorized = false
    private(set) var state: [String: Any] = ["phase": "idle"]
    var stateDidChange: (() -> Void)?
    var showAbout: (() -> Bool)?
    var prepareInstallation: ((@escaping (UpdatePreparationResult) -> Void) -> Void)?
    var localize: (String) -> String = { $0 }

    init(bundle: Bundle = .main, defaults: UserDefaults = .standard,
         makeUpdater: ((Bundle, AppUpdates) -> SPUUpdater)? = nil) {
        self.bundle = bundle; self.defaults = defaults; self.makeUpdater = makeUpdater; super.init()
    }
    private var testing: Bool { bundle.object(forInfoDictionaryKey: "Co2UpdateTesting") as? Bool == true }
    private var channel: String { bundle.object(forInfoDictionaryKey: "Co2UpdateChannel") as? String ?? "source" }
    private var feedURL: String { bundle.object(forInfoDictionaryKey: "SUFeedURL") as? String ?? "" }
    private var configured: Bool {
        ["preview", "stable"].contains(channel)
            && UpdatePolicy.validKey(bundle.object(forInfoDictionaryKey: "SUPublicEDKey") as? String)
            && UpdatePolicy.allowsFeed(feedURL, testing: testing)
            && bundle.object(forInfoDictionaryKey: "SUVerifyUpdateBeforeExtraction") as? Bool == true
            && bundle.object(forInfoDictionaryKey: "SURequireSignedFeed") as? Bool == true
            && bundle.object(forInfoDictionaryKey: "SUAllowsAutomaticUpdates") as? Bool == false
    }
    private var writableInstallation: Bool {
        let url = bundle.bundleURL
        guard url.pathExtension == "app", !url.path.contains("/AppTranslocation/"),
              FileManager.default.isWritableFile(atPath: url.path),
              FileManager.default.isWritableFile(atPath: url.deletingLastPathComponent().path) else { return false }
        return (try? url.resourceValues(forKeys: [.volumeIsReadOnlyKey]).volumeIsReadOnly) != true
    }
    var appInfo: [String: Any] {
        ["version": bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?",
         "build": bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?", "channel": channel,
         "starDismissed": defaults.bool(forKey: "co2StarDismissed"), "canUpdate": configured && writableInstallation]
    }
    private var phase: String { state["phase"] as? String ?? "idle" }
    var preventsTermination: Bool {
        !installationAuthorized && (gate.isPreparing || updater?.sessionInProgress == true || ["checking", "downloading", "extracting", "ready"].contains(phase))
    }
    func start() {
        guard configured else { publish("idle", message: "更新配置尚未完成，请前往 GitHub 下载。"); return }
        let instance = makeUpdater?(bundle, self) ?? SPUUpdater(hostBundle: bundle, applicationBundle: bundle, userDriver: self, delegate: self)
        updater = instance
        // The app has no profiling preference or automatic install option.
        instance.sendsSystemProfile = false
        do {
            try instance.start()
            lastChecked = instance.lastUpdateCheckDate
            publish("idle")
            if instance.automaticallyChecksForUpdates && UpdatePolicy.isDue(lastCheck: lastChecked, now: Date()) {
                instance.checkForUpdatesInBackground()
            }
        } catch { publish("error", message: "更新配置尚未完成，请前往 GitHub 下载。") }
    }
    func handle(_ object: [String: Any]) {
        guard let action = UpdatePolicy.action(object) else { return }
        switch action {
        case "info": stateDidChange?()
        case "check": check()
        case "install": install()
        case "cancel": cancel()
        case "dismissStar": defaults.set(true, forKey: "co2StarDismissed"); stateDidChange?()
        case "openLink": if let link = object["link"] as? String, let url = UpdatePolicy.link(link) { NSWorkspace.shared.open(url) }
        default: break
        }
    }
    func check() {
        userInitiated = true
        guard configured, let updater = updater else { fail("更新配置尚未完成，请前往 GitHub 下载。"); return }
        if updater.sessionInProgress { showUpdateInFocus(); return }
        installRequested = false; cancelRequested = false; installationAuthorized = false
        publish("checking"); updater.checkForUpdates()
    }
    func install() {
        userInitiated = true
        guard configured, let updater = updater else { fail("更新配置尚未完成，请前往 GitHub 下载。"); return }
        guard writableInstallation else { fail("当前安装无法自动更新，请前往 GitHub 下载。"); return }
        guard !updater.sessionInProgress, !gate.isPreparing else { showUpdateInFocus(); return }
        // Re-check the signed feed before downloading instead of keeping an
        // indefinitely active update session after a background discovery.
        installRequested = true; cancelRequested = false; installationAuthorized = false
        publish("checking"); updater.checkForUpdates()
    }
    func cancel() {
        guard !installationAuthorized else { return }
        cancelRequested = true; installRequested = false
        if gate.isPreparing { gate.cancel(); return }
        if let stop = cancellation {
            cancellation = nil; stop(); publish("idle", message: "更新已取消")
        } else if phase != "extracting" && phase != "ready" {
            publish("idle", message: "更新已取消")
        }
        // Extraction is not cancellable through Sparkle's public API. The
        // ready callback will answer .skip before installation is authorized.
    }
    private func publish(_ phase: String, message: String? = nil, progress: Double? = nil) {
        var next: [String: Any] = ["phase": phase]
        if let item = candidate { next["version"] = item.displayVersionString; next["build"] = item.versionString }
        if let message = message { next["message"] = message }
        if let progress = progress, progress.isFinite { next["progress"] = min(1, max(0, progress)) }
        if let checked = lastChecked { next["lastChecked"] = checked.timeIntervalSince1970 * 1000 }
        let previous = self.phase; state = next
        if previous == phase && ["downloading", "extracting"].contains(phase) {
            // Network callbacks can be much faster than a useful UI refresh.
            if !progressNotificationPending {
                progressNotificationPending = true
                let delay = max(0, 0.1 - Date().timeIntervalSince(lastProgressNotification))
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                    guard let self = self else { return }
                    self.progressNotificationPending = false; self.lastProgressNotification = Date(); self.stateDidChange?()
                }
            }
        } else { stateDidChange?() }
    }
    private func fail(_ message: String) {
        installRequested = false; publish("error", message: message)
        if userInitiated && showAbout?() != true { presentNativeState() }
    }
    private func remember(_ item: SUAppcastItem) { candidate = item; lastChecked = Date() }
    private func prepare(_ reply: @escaping (SPUUserUpdateChoice) -> Void) {
        cancellation = nil
        guard installRequested && !cancelRequested, let prepare = prepareInstallation else {
            reply(.skip); publish("idle", message: "更新已取消"); return
        }
        publish("ready")
        if !gate.begin(prepare: prepare, completion: { [weak self] result in
            guard let self = self else { reply(.skip); return }
            switch result {
            case .ready:
                self.installationAuthorized = true
                self.publish("installing", message: "更新准备就绪，即将重新打开应用。")
                reply(.install)
            case .cancelled:
                self.installRequested = false; self.cancelRequested = true
                reply(.skip); self.publish("idle", message: "更新已取消")
            case .failed:
                self.installRequested = false
                reply(.skip); self.fail("无法停止本地助手，已取消本次更新。请退出后重试。")
            }
        }) { reply(.skip) }
    }
    private func presentNativeState() {
        let alert = NSAlert(); alert.messageText = "Codex Co²"
        if phase == "available" {
            let version = candidate?.displayVersionString ?? "?", build = candidate?.versionString ?? "?"
            alert.informativeText = localize("检测到新版本：{version}（Build {build}）").replacingOccurrences(of: "{version}", with: version).replacingOccurrences(of: "{build}", with: build)
            alert.addButton(withTitle: localize("更新并重新打开")); alert.addButton(withTitle: localize("稍后"))
            if alert.runModal() == .alertFirstButtonReturn { install() }
        } else {
            let source = state["message"] as? String ?? (phase == "upToDate" ? "当前已是最新版本" : "正在准备更新…")
            alert.informativeText = localize(source)
            alert.addButton(withTitle: localize("好"))
            if preventsTermination { alert.addButton(withTitle: localize("取消更新")) }
            if alert.runModal() == .alertSecondButtonReturn { cancel() }
        }
    }

    // MARK: Sparkle user driver
    func show(_ request: SPUUpdatePermissionRequest, reply: @escaping (SUUpdatePermissionResponse) -> Void) {
        reply(SUUpdatePermissionResponse(automaticUpdateChecks: true, automaticUpdateDownloading: false, sendSystemProfile: false))
    }
    func showUserInitiatedUpdateCheck(cancellation: @escaping () -> Void) {
        self.cancellation = cancellation; publish("checking")
    }
    func showUpdateFound(with item: SUAppcastItem, state updateState: SPUUserUpdateState, reply: @escaping (SPUUserUpdateChoice) -> Void) {
        remember(item); cancellation = nil
        if item.isInformationOnlyUpdate { reply(.dismiss); fail("当前安装无法自动更新，请前往 GitHub 下载。"); return }
        if updateState.stage == .installing { prepare(reply); return }
        if updateState.stage == .downloaded && !installRequested {
            // Do not preserve a staged installer from another application
            // session without a fresh explicit install action. Manual checks
            // still discover this version even after Sparkle's .skip response.
            publish("available"); reply(.skip); return
        }
        if installRequested && !cancelRequested {
            guard writableInstallation else { reply(.dismiss); fail("当前安装无法自动更新，请前往 GitHub 下载。"); return }
            reply(.install)
        } else {
            publish("available"); nativePresentationPending = userInitiated && showAbout?() != true
            reply(.dismiss)
        }
    }
    func showUpdateReleaseNotes(with downloadData: SPUDownloadData) {}
    func showUpdateReleaseNotesFailedToDownloadWithError(_ error: Error) {}
    func showUpdateNotFoundWithError(_ error: Error, acknowledgement: @escaping () -> Void) {
        noUpdate(error as NSError); nativePresentationPending = userInitiated && showAbout?() != true; acknowledgement()
    }
    func showUpdaterError(_ error: Error, acknowledgement: @escaping () -> Void) {
        let message = ["downloading", "extracting", "ready", "installing"].contains(phase)
            ? "更新下载或验证失败，请重试。" : "检查更新失败，请检查网络后重试。"
        installationAuthorized = false; installRequested = false; publish("error", message: message)
        nativePresentationPending = userInitiated && showAbout?() != true; acknowledgement()
    }
    func showDownloadInitiated(cancellation: @escaping () -> Void) {
        self.cancellation = cancellation; expectedBytes = 0; receivedBytes = 0; publish("downloading")
    }
    func showDownloadDidReceiveExpectedContentLength(_ expectedContentLength: UInt64) { expectedBytes = expectedContentLength }
    func showDownloadDidReceiveData(ofLength length: UInt64) {
        receivedBytes = receivedBytes.addingReportingOverflow(length).partialValue
        publish("downloading", progress: expectedBytes > 0 ? Double(receivedBytes) / Double(expectedBytes) : nil)
    }
    func showDownloadDidStartExtractingUpdate() { cancellation = nil; publish("extracting") }
    func showExtractionReceivedProgress(_ progress: Double) { publish("extracting", progress: progress) }
    func showReady(toInstallAndRelaunch reply: @escaping (SPUUserUpdateChoice) -> Void) { prepare(reply) }
    func showInstallingUpdate(withApplicationTerminated applicationTerminated: Bool, retryTerminatingApplication: @escaping () -> Void) {
        // The ready gate authorizes installation only after the service has
        // exited. Never use retryTerminatingApplication to bypass that gate.
        if installationAuthorized { publish("installing") }
    }
    func showUpdateInstalledAndRelaunched(_ relaunched: Bool, acknowledgement: @escaping () -> Void) { acknowledgement() }
    func dismissUpdateInstallation() {
        cancellation = nil
        if !["available", "upToDate", "error", "installing"].contains(phase) { publish("idle", message: cancelRequested ? "更新已取消" : nil) }
    }
    func showUpdateInFocus() { if showAbout?() != true { presentNativeState() } }

    // MARK: Sparkle updater delegate
    func allowedChannels(for updater: SPUUpdater) -> Set<String> { UpdatePolicy.channels(channel) }
    func feedURLString(for updater: SPUUpdater) -> String? { feedURL }
    func updater(_ updater: SPUUpdater, mayPerform updateCheck: SPUUpdateCheck) throws {
        if updateCheck == .updatesInBackground && !UpdatePolicy.isDue(lastCheck: lastChecked, now: Date()) {
            throw NSError(domain: "local.codexco2.update-policy", code: 1)
        }
        if updateCheck == .updatesInBackground { userInitiated = false }
        lastChecked = Date(); publish("checking")
    }
    func updater(_ updater: SPUUpdater, shouldProceedWithUpdate item: SUAppcastItem, updateCheck: SPUUpdateCheck) throws {
        guard item.isInformationOnlyUpdate || UpdatePolicy.allowsArchive(item.fileURL, testing: testing) else {
            throw NSError(domain: "local.codexco2.update-policy", code: 2)
        }
    }
    func updater(_ updater: SPUUpdater, shouldDownloadReleaseNotesForUpdate item: SUAppcastItem) -> Bool { false }
    func updater(_ updater: SPUUpdater, didFindValidUpdate item: SUAppcastItem) { remember(item) }
    func updaterDidNotFindUpdate(_ updater: SPUUpdater, error: Error) { noUpdate(error as NSError) }
    private func noUpdate(_ error: NSError) {
        candidate = nil; installRequested = false; lastChecked = Date()
        let reason = (error.userInfo[SPUNoUpdateFoundReasonKey] as? NSNumber)?.intValue
        if reason == Int(SPUNoUpdateFoundReason.systemIsTooOld.rawValue) || reason == Int(SPUNoUpdateFoundReason.systemIsTooNew.rawValue) {
            publish("error", message: "最新版本要求更新的 macOS，请前往 GitHub 查看。")
        } else if reason == Int(SPUNoUpdateFoundReason.onLatestVersion.rawValue) || reason == Int(SPUNoUpdateFoundReason.onNewerThanLatestVersion.rawValue) {
            publish("upToDate")
        } else { publish("error", message: "未找到可安装的更新，请前往 GitHub 查看。") }
    }
    func updater(_ updater: SPUUpdater, didFinishUpdateCycleFor updateCheck: SPUUpdateCheck, error: Error?) {
        cancellation = nil
        if let error = error as NSError?, phase == "checking" {
            if error.domain == SUSparkleErrorDomain && error.code == Int(SUError.noUpdateError.rawValue) { noUpdate(error) }
            else { publish("error", message: "检查更新失败，请检查网络后重试。") }
        }
        if nativePresentationPending {
            nativePresentationPending = false
            DispatchQueue.main.async { [weak self] in self?.presentNativeState() }
        }
    }
}
