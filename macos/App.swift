import AppKit
import WebKit
import UserNotifications

struct InvitationClipboard {
    static func isPrivateIPv4(_ host: String) -> Bool {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return false }
        let octets = parts.compactMap { Int($0) }
        guard octets.count == 4, zip(parts, octets).allSatisfy({ String($0.1) == $0.0 && (0...255).contains($0.1) }) else { return false }
        return octets[0] == 10 || (octets[0] == 172 && (16...31).contains(octets[1])) || (octets[0] == 192 && octets[1] == 168)
    }
    static func isToken(_ raw: String) -> Bool {
        guard raw.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
              let bytes = Data(base64Encoded: raw.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + "="), bytes.count == 32 else { return false }
        return bytes.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") == raw
    }
    static func accepts(_ raw: String) -> Bool {
        guard raw.utf8.count < 4096, !raw.unicodeScalars.contains(where: { CharacterSet.whitespacesAndNewlines.union(.controlCharacters).contains($0) }),
              let url = URLComponents(string: raw), let host = url.host, !host.isEmpty,
              url.user == nil, url.password == nil, url.query == nil, ["", "/"].contains(url.path),
              url.port == nil || (1...65535).contains(url.port!), let fragment = url.percentEncodedFragment else { return false }
        if url.scheme?.lowercased() == "http" {
            guard isPrivateIPv4(host), url.percentEncodedHost == host, url.port != nil else { return false }
        } else if url.scheme?.lowercased() != "https" { return false }
        var fields: [String: String] = [:]
        for field in fragment.split(separator: "&", omittingEmptySubsequences: false) {
            let pair = field.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard pair.count == 2, ["room", "invite", "scope"].contains(String(pair[0])), fields[String(pair[0])] == nil else { return false }
            fields[String(pair[0])] = String(pair[1])
        }
        guard let room = fields["room"], room.range(of: "^[A-Za-z0-9_-]{8,128}$", options: .regularExpression) != nil,
              let invite = fields["invite"], isToken(invite) else { return false }
        return fields["scope"].map { $0.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil } ?? true
    }
    static func copy(_ raw: String, to board: NSPasteboard = .general) -> Bool {
        guard accepts(raw) else { return false }
        board.clearContents()
        return board.setString(raw, forType: .string)
    }
    static func response(to body: Any, board: NSPasteboard = .general) -> [String: Any]? {
        guard let request = body as? [String: Any], let requestID = request["requestId"] as? String,
              requestID.utf8.count <= 64, requestID.range(of: "^copy-[1-9][0-9]*$", options: .regularExpression) != nil else { return nil }
        let validShape = Set(request.keys) == Set(["requestId", "url"])
        let ok = validShape && (request["url"] as? String).map { copy($0, to: board) } == true
        return ["requestId": requestID, "ok": ok]
    }
}

struct AttentionLedger {
    private var announced: [String: Set<String>] = [:]
    mutating func reconcile(_ current: [String: Set<String>], enabled: Bool) -> [String] {
        announced = announced.filter { current[$0.key] != nil }
        guard enabled else { return [] }
        var changed: [String] = []
        for (id, members) in current {
            if !members.subtracting(announced[id] ?? []).isEmpty { changed.append(id) }
            announced[id] = members
        }
        return changed
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, UNUserNotificationCenterDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var statusItem: NSStatusItem!
    var statusLabel: NSTextField!
    var helper: Process?
    var input: Pipe?
    var output: Pipe?
    var outputBuffer = Data()
    var ownerURL: URL?
    var managerOrigin: URL?
    var exiting = false
    var activeRooms: Int?
    var pendingAbout = false
    var helperStopWaiters: [(Bool) -> Void] = []
    var helperStopToken: UUID?
    var helperStopForce = false
    let backgroundRegistration = BackgroundRegistration()
    var activeRuntime: URL?
    var backgroundEnabled = true
    var usingManagedService = false
    var backgroundActive = false
    var backgroundMessage: String?
    var backgroundRegistrationError: [String: Any]?
    var backgroundEnablePendingRestart = false
    var backgroundSaveID: Int?
    var bridgeConnected = false
    var bridgeLaunchAttempts = 0
    var serviceStoppedConfirmed = false
    var serviceStopRequested = false
    var foregroundDaemon: Process?
    var managedStartAttempt: UUID?
    var managedStartupRequired = false
    var startupAttempt: UUID?
    var startupTimeout: TimeInterval = 20
    var startupFailure: String?
    var startupPanel: NSStackView?
    var startupExplanation: NSTextField?
    var startupRetry: NSButton?
    var changingRuntime = false
    let updates = AppUpdates()
    var sequence = 0
    var helperGeneration = 0
    var attention: [String: [String: Any]] = [:]
    var notificationLedger = AttentionLedger()
    var notificationsAllowed = false
    var requestingNotifications = false
    var requestedNotifications = false
    var pendingAttentionID: String?
    let attentionTitles = ["guest": "访客申请加入", "invite-recovery": "邀请恢复申请", "proposal": "协作消息待审批", "tool": "Codex 工具等待审批",
                           "unknown": "消息提交结果待核实", "offline": "共享连接中断", "connection": "公网入口不可用", "share-stopped": "共享已异常结束或到期"]
    var language = UserDefaults.standard.string(forKey: "interfaceLanguage").flatMap { ["zh-CN", "zh-TW", "en"].contains($0) ? $0 : nil } ?? "zh-CN"
    var statusSource = "正在启动本地管理…"
    var statusTitleSource = "Co²"
    lazy var messages: [String: [String: String]] = {
        guard let url = Bundle.main.resourceURL?.appendingPathComponent("service/owner/locales.json"),
              let bytes = try? Data(contentsOf: url),
              let data = try? JSONSerialization.jsonObject(with: bytes) as? [String: [String: String]] else { return [:] }
        return data
    }()
    func localized(_ source: String) -> String {
        if let result = messages[language]?[source] { return result }
        for (pattern, key) in [("^本地管理就绪 · ([0-9]+) 条共享$", "本地管理就绪 · {count} 条共享"),
                               ("^Co² · 待确认 ([0-9]+)$", "Co² · 待确认 {count}"),
                               ("^Co² · 共享 ([0-9]+)$", "Co² · 共享 {count}")] {
            if let regex = try? NSRegularExpression(pattern: pattern),
               let match = regex.firstMatch(in: source, range: NSRange(source.startIndex..., in: source)),
               let range = Range(match.range(at: 1), in: source) {
                return (messages[language]?[key] ?? key).replacingOccurrences(of: "{count}", with: String(source[range]))
            }
        }
        return source
    }
    func setStatus(_ source: String) { statusSource = source; statusLabel?.stringValue = localized(source) }
    func setStatusTitle(_ source: String) { statusTitleSource = source; statusItem?.button?.title = localized(source) }
    func installLanguageScript(_ controller: WKUserContentController) {
        guard let bytes = try? JSONSerialization.data(withJSONObject: ["language": language, "info": updates.appInfo, "state": updates.state, "background": backgroundState]),
              let json = String(data: bytes, encoding: .utf8) else { return }
        controller.removeAllUserScripts()
        controller.addUserScript(WKUserScript(source: "{ const data = \(json); window.co2Language = data.language; window.co2AppInfo = data.info; window.co2UpdateState = data.state; window.co2BackgroundState = data.background; }", injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }
    func configureUpdates() {
        updates.localize = { [weak self] source in self?.localized(source) ?? source }
        updates.stateDidChange = { [weak self] in self?.publishUpdates() }
        updates.showAbout = { [weak self] in self?.showAboutPage() ?? false }
        updates.prepareInstallation = { [weak self] completion in
            guard let self = self else { completion(.failed); return }
            self.prepareUpdateInstallation(completion)
        }
        updates.start()
    }
    func publishUpdates() {
        guard let view = webView else { return }
        installLanguageScript(view.configuration.userContentController)
        guard let owner = managerOrigin, let current = view.url,
              current.scheme == owner.scheme, current.host == owner.host, current.port == owner.port,
              let bytes = try? JSONSerialization.data(withJSONObject: ["info": updates.appInfo, "state": updates.state]),
              let json = String(data: bytes, encoding: .utf8) else { return }
        view.evaluateJavaScript("{ const data = \(json); window.co2AppInfo = data.info; window.co2UpdateState = data.state; window.receiveCo2AppInfo?.(data.info); window.receiveCo2UpdateState?.(data.state); }", completionHandler: nil)
    }
    var backgroundSupported: Bool {
        backgroundRegistration.available && !CommandLine.arguments.contains("--runtime-dir")
    }
    var backgroundState: [String: Any] {
        let registration = backgroundRegistration.status
        let status: String
        if !backgroundEnabled { status = "disabled" }
        else if registration == "requires-approval" { status = "requires-approval" }
        else if !backgroundSupported { status = "unavailable" }
        else if !usingManagedService {
            status = BackgroundRegistrationPolicy.foregroundStatus(registration: registration, connected: bridgeConnected,
                                                                    pendingEnable: backgroundEnablePendingRestart)
        }
        else if backgroundActive && bridgeConnected { status = "running" }
        else { status = helper?.isRunning == true ? "starting" : "stopped" }
        var state: [String: Any] = ["supported": backgroundSupported, "enabled": backgroundEnabled,
                                    "status": status, "saving": backgroundSaveID != nil, "registration": registration]
        if let message = backgroundMessage { state["message"] = message }
        if let error = backgroundRegistrationError { state["registrationError"] = error }
        return state
    }
    func publishBackground() {
        guard let view = webView else { return }
        installLanguageScript(view.configuration.userContentController)
        guard let owner = managerOrigin, let current = view.url,
              current.scheme == owner.scheme, current.host == owner.host, current.port == owner.port,
              let bytes = try? JSONSerialization.data(withJSONObject: backgroundState),
              let json = String(data: bytes, encoding: .utf8) else { return }
        view.evaluateJavaScript("{ const state = \(json); window.co2BackgroundState = state; window.receiveCo2BackgroundState?.(state); }", completionHandler: nil)
    }
    func changeBackground(_ enabled: Bool) {
        guard backgroundSaveID == nil, helper?.isRunning == true, bridgeConnected else {
            backgroundMessage = "助手未连接，无法修改后台设置。"; publishBackground(); return
        }
        backgroundMessage = nil
        send("set-background", fields: ["enabled": enabled]); backgroundSaveID = sequence
        let requestID = sequence; publishBackground()
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
            guard let self = self, self.backgroundSaveID == requestID else { return }
            self.backgroundSaveID = nil
            self.backgroundMessage = "后台设置保存结果未确认，请重新打开设置核对。"
            if let directory = self.activeRuntime, let enabled = try? BackgroundConfiguration.enabled(runtime: directory) {
                self.backgroundEnabled = enabled
            }
            self.publishBackground()
        }
    }
    func unregisterBackground(_ completion: @escaping (Bool) -> Void) {
        // An explicit temporary runtime must never change the installed app's
        // login service. This also keeps isolated native acceptance harmless.
        guard backgroundSupported else { completion(true); return }
        backgroundRegistration.unregister(completion)
    }
    var defaultRuntimeDir: String {
        BackgroundConfiguration.defaultRuntime().path
    }
    var runtimeDir: String {
        activeRuntime?.path ?? defaultRuntimeDir
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        if let bundleID = Bundle.main.bundleIdentifier,
           let existing = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).first(where: { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }) {
            DistributedNotificationCenter.default().postNotificationName(Notification.Name("local.codexco2.manager.show"), object: nil)
            existing.activate(options: [.activateAllWindows]); NSApp.terminate(nil); return
        }
        NSApp.setActivationPolicy(.regular)
        buildMenus(); buildWindow(); configureUpdates(); showWindow(); launchHelper()
        let center = UNUserNotificationCenter.current(); center.delegate = self
        // Clear notifications from a previous process: their room IDs cannot
        // authorize or recover a new sharing service.
        center.removeAllDeliveredNotifications(); center.removeAllPendingNotificationRequests()
        center.getNotificationSettings { settings in DispatchQueue.main.async {
            self.notificationsAllowed = settings.authorizationStatus == .authorized
            self.syncAttentionNotifications()
        } }
        DistributedNotificationCenter.default().addObserver(self, selector: #selector(showFromNotification(_:)), name: Notification.Name("local.codexco2.manager.show"), object: nil)
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(checkAfterWake(_:)), name: NSWorkspace.didWakeNotification, object: nil)
    }
    @objc func checkAfterWake(_ notification: Notification) { send("check-network") }
    func applicationDidBecomeActive(_ notification: Notification) {
        publishBackground()
        UNUserNotificationCenter.current().getNotificationSettings { settings in DispatchQueue.main.async {
            self.notificationsAllowed = settings.authorizationStatus == .authorized
            self.syncAttentionNotifications()
        } }
    }
    func buildMenus() {
        let main = NSMenu(); let appItem = NSMenuItem(); let appMenu = NSMenu()
        appMenu.addItem(withTitle: localized("关于 Codex Co²"), action: #selector(about), keyEquivalent: "")
        appMenu.addItem(withTitle: localized("检查更新…"), action: #selector(checkUpdates), keyEquivalent: "")
        appMenu.addItem(withTitle: localized("设置…"), action: #selector(showSettings), keyEquivalent: ",")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: localized("退出 Codex Co²"), action: #selector(quit), keyEquivalent: "q")
        appItem.submenu = appMenu; main.addItem(appItem)
        let editItem = NSMenuItem(); let edit = NSMenu(title: localized("编辑"))
        for (title, action, key) in [("拷贝", "copy:", "c"), ("粘贴", "paste:", "v"), ("全选", "selectAll:", "a")] {
            edit.addItem(withTitle: localized(title), action: Selector(action), keyEquivalent: key)
        }
        editItem.submenu = edit; main.addItem(editItem); NSApp.mainMenu = main
        let windowItem = NSMenuItem(); let windowMenu = NSMenu(title: localized("窗口"))
        windowMenu.addItem(withTitle: localized("关闭窗口"), action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowItem.submenu = windowMenu; main.addItem(windowItem)
        if statusItem == nil { statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength) }
        setStatusTitle(statusTitleSource)
        let menu = NSMenu()
        for (title, action) in [("显示管理窗口", #selector(showWindow)), ("打开 Codex", #selector(openDesktop)),
                                ("连接当前 Codex", #selector(connectCurrent)), ("停止全部共享", #selector(revokeAll)),
                                ("选择运行目录…", #selector(selectRuntime)), ("重新连接助手", #selector(retry))] {
            let item = menu.addItem(withTitle: localized(title), action: action, keyEquivalent: ""); item.target = self
        }
        menu.addItem(.separator())
        let quitItem = menu.addItem(withTitle: localized("退出"), action: #selector(quit), keyEquivalent: "q"); quitItem.target = self
        statusItem.menu = menu
    }
    func buildWindow() {
        let canvas = NSColor(calibratedWhite: 0.941, alpha: 1)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Codex Co²"; window.center(); window.delegate = self; window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: .aqua); window.backgroundColor = canvas
        window.titlebarAppearsTransparent = true; window.minSize = NSSize(width: 900, height: 640)
        let root = NSView()
        statusLabel = NSTextField(labelWithString: localized(statusSource))
        statusLabel.font = .systemFont(ofSize: 10); statusLabel.textColor = .tertiaryLabelColor
        statusLabel.lineBreakMode = .byTruncatingTail
        let config = WKWebViewConfiguration(); config.websiteDataStore = .nonPersistent()
        config.userContentController.add(self, name: "copyInvite")
        config.userContentController.add(self, name: "languagePreference")
        config.userContentController.add(self, name: "notificationSettings")
        config.userContentController.add(self, name: "appUpdates")
        config.userContentController.add(self, name: "backgroundService")
        installLanguageScript(config.userContentController)
        webView = WKWebView(frame: .zero, configuration: config); webView.navigationDelegate = self; webView.uiDelegate = self
        for view in [statusLabel!, webView!] {
            view.translatesAutoresizingMaskIntoConstraints = false; root.addSubview(view)
        }
        let explanation = NSTextField(wrappingLabelWithString: "")
        explanation.alignment = .center; explanation.font = .systemFont(ofSize: 14)
        let retry = NSButton(title: localized("重新连接助手"), target: self, action: #selector(self.retry))
        let settings = NSButton(title: localized("打开系统后台设置"), target: self, action: #selector(openBackgroundSettings))
        let actions = NSStackView(views: [retry, settings]); actions.spacing = 12
        let panel = NSStackView(views: [explanation, actions]); panel.orientation = .vertical; panel.spacing = 20
        panel.translatesAutoresizingMaskIntoConstraints = false; panel.isHidden = true
        root.addSubview(panel); startupPanel = panel; startupExplanation = explanation; startupRetry = retry
        window.contentView = root
        NSLayoutConstraint.activate([
            panel.centerXAnchor.constraint(equalTo: root.centerXAnchor), panel.centerYAnchor.constraint(equalTo: root.centerYAnchor),
            panel.widthAnchor.constraint(equalToConstant: 480),

            webView.topAnchor.constraint(equalTo: root.topAnchor), webView.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: root.trailingAnchor), webView.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -24),
            statusLabel.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 24), statusLabel.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -24),
            statusLabel.centerYAnchor.constraint(equalTo: webView.bottomAnchor, constant: 10)
        ])
    }
    @objc func showSettings() {
        showWindow()
        webView?.evaluateJavaScript("window.showCo2Settings?.()", completionHandler: nil)
    }
    @objc func showWindow() { window?.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
    @objc func showFromNotification(_ notification: Notification) { showWindow() }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { showWindow(); return true }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func windowShouldClose(_ sender: NSWindow) -> Bool { sender.orderOut(nil); return false }
    @objc func about() {
        if showAboutPage() { return }
        pendingAbout = true; showWindow()
        let alert = NSAlert(); alert.messageText = "Codex Co²"
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
        let versionLabel = localized("版本 {version}（{build}）").replacingOccurrences(of: "{version}", with: version).replacingOccurrences(of: "{build}", with: build)
        alert.informativeText = [versionLabel, "Real-time collaboration for Codex", localized("共享一条 Codex 会话，一起推进工作。"), "",
                                 localized("Apple Silicon 内部试用包 · 未公证"), localized("连接日常 Codex，默认直接接收协作消息，可按会话开启审批。")].joined(separator: "\n")
        alert.addButton(withTitle: localized("好")); alert.addButton(withTitle: localized("检查更新…"))
        alert.addButton(withTitle: "GitHub")
        let answer = alert.runModal()
        if answer == .alertSecondButtonReturn { updates.check() }
        else if answer == .alertThirdButtonReturn, let url = UpdatePolicy.link("repository") { NSWorkspace.shared.open(url) }
    }
    @discardableResult func showAboutPage() -> Bool {
        guard let owner = managerOrigin, let current = webView?.url,
              current.scheme == owner.scheme, current.host == owner.host, current.port == owner.port else { return false }
        showWindow(); pendingAbout = true
        webView.evaluateJavaScript("window.showCo2About?.()") { [weak self] result, _ in
            if result as? Bool == true { self?.pendingAbout = false }
        }
        return true
    }
    @objc func checkUpdates() { updates.check() }
    @objc func openBackgroundSettings() { backgroundRegistration.openSettings() }
    func message(_ text: String) { setStatus(text); let alert = NSAlert(); alert.messageText = "Codex Co²"; alert.informativeText = localized(text); alert.runModal() }

    func beginStartup() {
        let token = UUID(); startupAttempt = token; startupFailure = nil
        startupPanel?.isHidden = true
        setStatus("正在启动本地管理…"); setStatusTitle("Co² · 启动中")
        DispatchQueue.main.asyncAfter(deadline: .now() + startupTimeout) { [weak self] in
            guard let self = self, self.startupAttempt == token, self.ownerURL == nil,
                  !self.exiting, !self.changingRuntime, !self.serviceStopRequested else { return }
            self.failStartup("本地管理启动超时。请检查系统登录项权限或重新连接助手。")
            // Only close the management bridge. An independent managed service
            // may still own shares; a timeout is never permission to kill it.
            if self.helper?.isRunning == true { self.helper?.terminate() }
        }
    }
    func failStartup(_ reason: String, detail: String? = nil) {
        startupAttempt = nil; startupFailure = reason
        setStatus(reason); setStatusTitle("Co² · 启动失败")
        startupExplanation?.stringValue = [localized(reason), detail].compactMap { $0 }.joined(separator: "\n")
        startupRetry?.isEnabled = helper == nil && managedStartAttempt == nil
        startupPanel?.isHidden = false
    }
    func didStopForeground(_ process: Process) {
        guard foregroundDaemon === process else { return }
        foregroundDaemon = nil
        guard ownerURL == nil, startupFailure == nil, !serviceStopRequested,
              !exiting, !changingRuntime, !updates.installationAuthorized else { return }
        let label = process.terminationReason == .uncaughtSignal ? localized("终止信号") : localized("退出代码")
        failStartup("本地服务未能启动。请检查运行目录权限或重新连接助手。", detail: "\(label): \(process.terminationStatus)")
        if helper?.isRunning == true { helper?.terminate() }
    }
    func finishManagedStart(_ result: BackgroundStartResult, attempt: UUID) {
        guard managedStartAttempt == attempt else { return }
        managedStartAttempt = nil
        startupRetry?.isEnabled = helper == nil
        if result == .cancelled {
            if startupFailure == nil && !exiting { failStartup("本地管理启动已取消，请重新连接助手。") }
            return
        }
        guard startupAttempt == attempt, startupFailure == nil, usingManagedService,
              backgroundEnabled, !exiting, !changingRuntime, !serviceStopRequested,
              !updates.installationAuthorized else { return }
        if result == .started { launchBridge(); return }
        let code: Int32
        switch result {
        case .missing: code = 113
        case .failed(let status): code = status
        case .started, .cancelled: return
        }
        if result == .missing && backgroundRegistration.status != "enabled" { usingManagedService = false }
        backgroundMessage = "后台服务无法启动。请检查系统登录项设置后重试。"
        backgroundRegistrationError = ["domain": "launchctl", "code": code]
        publishBackground(); failStartup(backgroundMessage!, detail: "\(localized("退出代码")): \(code)")
    }
    func launchHelper() {
        guard helper == nil, startupAttempt == nil, managedStartAttempt == nil, !exiting, !changingRuntime,
              !updates.installationAuthorized, let resources = Bundle.main.resourceURL else { return }
        // A timed-out bridge does not prove its service has stopped. Reuse a
        // still-owned foreground daemon instead of starting a second one.
        if foregroundDaemon?.isRunning == true {
            bridgeLaunchAttempts = 0; serviceStopRequested = false; beginStartup(); launchBridge(); return
        }
        guard !CommandLine.arguments.contains("--isolated") else {
            let explanation = "此安装包仅支持连接日常 Codex。隔离实验请从源码运行。"
            setStatus(explanation); message(explanation); return
        }
        do {
            activeRuntime = try BackgroundConfiguration.runtime()
            backgroundEnabled = try BackgroundConfiguration.enabled(runtime: activeRuntime!)
            managedStartupRequired = backgroundEnabled && (managedStartupRequired || BackgroundConfiguration.hasRecoveryState(runtime: activeRuntime!))
        } catch {
            backgroundMessage = "后台设置无法读取，请检查运行目录权限。"
            publishBackground(); message(backgroundMessage!); return
        }
        backgroundMessage = nil; backgroundRegistrationError = nil; backgroundEnablePendingRestart = false
        bridgeLaunchAttempts = 0; serviceStopRequested = false; beginStartup()
        if backgroundEnabled && backgroundSupported {
            do { try backgroundRegistration.register() }
            catch {
                let failure = error as NSError
                let domain = failure.domain.range(of: "^[A-Za-z0-9._-]{1,96}$", options: .regularExpression) == nil ? "unknown" : failure.domain
                backgroundRegistrationError = ["domain": domain, "code": failure.code]
                if backgroundRegistration.status != "requires-approval" { backgroundMessage = "无法启用后台服务，请检查系统登录项设置。" }
            }
        }
        usingManagedService = backgroundEnabled && backgroundSupported && backgroundRegistration.status == "enabled"
        if usingManagedService {
            managedStartupRequired = true
            let attempt = startupAttempt!; managedStartAttempt = attempt
            backgroundRegistration.start(shouldContinue: { [weak self] in
                guard let self = self else { return false }
                return self.startupAttempt == attempt && self.startupFailure == nil && self.usingManagedService
                    && self.backgroundEnabled && !self.exiting && !self.changingRuntime
                    && !self.serviceStopRequested && !self.updates.installationAuthorized
            }, completion: { [weak self] result in self?.finishManagedStart(result, attempt: attempt) })
            return
        }
        else if managedStartupRequired {
            // A failed repair or an existing recovery checkpoint requires the
            // managed service even after retry/relaunch. Foreground startup
            // intentionally erases that checkpoint and is not a safe fallback.
            backgroundMessage = "已有后台共享记录。请恢复系统后台许可后重试，以保留邀请恢复资格。"
            publishBackground(); failStartup(backgroundMessage!); return
        }
        else {
            let daemon = Process(); daemon.executableURL = resources.appendingPathComponent("runtime/node")
            daemon.arguments = BackgroundConfiguration.arguments(resources: resources, runtime: activeRuntime!, mode: "--daemon") + ["--foreground"]
            if let official = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.openai.codex") {
                daemon.arguments?.append(contentsOf: ["--desktop-app", official.path])
            }
            daemon.environment = BackgroundConfiguration.environment(resources: resources)
            daemon.currentDirectoryURL = resources
            daemon.standardInput = FileHandle.nullDevice; daemon.standardOutput = FileHandle.nullDevice; daemon.standardError = FileHandle.nullDevice
            daemon.terminationHandler = { [weak self] process in
                DispatchQueue.main.async { self?.didStopForeground(process) }
            }
            do { foregroundDaemon = daemon; try daemon.run() }
            catch {
                foregroundDaemon = nil; backgroundMessage = "无法启动内置助手。请重新安装完整的应用包。"
                publishBackground(); failStartup(backgroundMessage!); return
            }
        }
        launchBridge()
    }
    func launchBridge() {
        guard helper == nil, startupFailure == nil, !exiting, !changingRuntime, !updates.installationAuthorized,
              let resources = Bundle.main.resourceURL, let activeRuntime = activeRuntime else { return }
        if startupAttempt == nil { beginStartup() }
        ownerURL = nil; activeRooms = nil; helperGeneration += 1; let generation = helperGeneration
        bridgeConnected = false; serviceStoppedConfirmed = false; bridgeLaunchAttempts += 1
        setStatus("正在启动本地管理…"); setStatusTitle("Co² · 启动中")
        let binaries = resources.appendingPathComponent("runtime")
        let process = Process(); process.executableURL = binaries.appendingPathComponent("node")
        process.arguments = BackgroundConfiguration.arguments(resources: resources, runtime: activeRuntime, mode: "--connect")
        process.currentDirectoryURL = resources
        process.environment = BackgroundConfiguration.environment(resources: resources)
        let stdinPipe = Pipe(), stdoutPipe = Pipe(); process.standardInput = stdinPipe; process.standardOutput = stdoutPipe
        process.standardError = FileHandle.nullDevice // Never log capabilities, authentication URLs or backend diagnostics.
        input = stdinPipe; output = stdoutPipe; outputBuffer = Data()
        stdoutPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            DispatchQueue.main.async {
                guard let self = self, self.helperGeneration == generation else { return }
                if data.isEmpty { handle.readabilityHandler = nil; return }
                self.consumeOutput(data)
            }
        }
        process.terminationHandler = { [weak self] _ in DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
            self?.didStopHelper(process, generation: generation)
        } }
        do {
            helper = process; try process.run()
            try? stdoutPipe.fileHandleForWriting.close()
            try? stdinPipe.fileHandleForReading.close()
        }
        catch {
            stdoutPipe.fileHandleForReading.readabilityHandler = nil
            helper = nil; input = nil; output = nil
            failStartup("无法启动内置助手。请重新安装完整的应用包。")
        }
    }
    func consumeOutput(_ data: Data) {
        outputBuffer.append(data)
        if outputBuffer.count > 131072 { stopHelper(); message("助手返回了无效数据，请重新连接。"); return }
        while let newline = outputBuffer.firstIndex(of: 10) {
            let line = outputBuffer[..<newline]; outputBuffer.removeSubrange(...newline)
            if let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any] { receive(object) }
        }
    }
    func send(_ command: String, fields: [String: Any] = [:]) {
        guard helper?.isRunning == true, let input = input else { message("助手未连接，请从菜单栏重新连接。"); return }
        sequence += 1
        var request = fields; request["type"] = command; request["id"] = sequence
        if let data = try? JSONSerialization.data(withJSONObject: request) {
            do { try input.fileHandleForWriting.write(contentsOf: data + Data([10])) } catch { setStatus("助手已断开") }
        }
    }
    func receive(_ object: [String: Any]) {
        let type = object["type"] as? String ?? ""
        // The service owns its tunnel. A management bridge disconnect is never
        // evidence that the tunnel is orphaned.
        if type == "background-state", let enabled = object["enabled"] as? Bool {
            bridgeConnected = true; bridgeLaunchAttempts = 0; backgroundEnabled = enabled
            backgroundActive = object["background"] as? Bool == true
            publishBackground()
        }
        if type == "stopped" { serviceStoppedConfirmed = true; backgroundActive = false; publishBackground() }
        if type == "result", object["command"] as? String == "set-background", let enabled = object["enabled"] as? Bool {
            backgroundSaveID = nil; backgroundEnabled = enabled; backgroundMessage = nil
            backgroundEnablePendingRestart = enabled && !usingManagedService
            if enabled && backgroundRegistrationError != nil && backgroundRegistration.status != "requires-approval" {
                backgroundMessage = "无法启用后台服务，请检查系统登录项设置。"
            }
            publishBackground()
        }
        if type == "error", backgroundSaveID != nil, object["id"] as? Int == backgroundSaveID {
            backgroundSaveID = nil; backgroundMessage = "后台设置未能保存，请重试。"; publishBackground()
        }
        if type == "ready", startupFailure == nil, let raw = object["ownerUrl"] as? String, let url = URL(string: raw), url.scheme == "http", url.host == "127.0.0.1", url.port != nil {
            startupAttempt = nil; startupFailure = nil; startupPanel?.isHidden = true
            ownerURL = url; managerOrigin = url; webView.load(URLRequest(url: url)); send("account"); return
        }
        if type == "status" {
            if let items = object["attention"] as? [[String: Any]] { updateAttention(items) }
            let phase = object["phase"] as? String ?? "starting", rooms = object["rooms"] as? Int ?? 0, pending = object["pending"] as? Int ?? 0
            activeRooms = rooms
            if startupFailure != nil { return }
            let network = (object["connection"] as? [String: Any])?["state"] as? String ?? ""
            setStatusTitle(pending > 0 ? "Co² · 待确认 \(pending)" : rooms > 0 ? "Co² · 共享 \(rooms)" : "Co²")
            if phase == "stopped" { updateAttention([]); setStatus("共享已停止") }
            else if phase == "waiting-desktop" { setStatus("等待日常 Codex 就绪后恢复共享服务。") }
            else if phase == "connecting" { setStatus("正在建立公网入口…") }
            else if network == "unavailable" { setStatus("公网入口无法访问，请检查连接") }
            else if network == "recovering" { setStatus("公网连接波动，正在恢复原链接") }
            else if network == "stopped" { setStatus("隧道已退出，请重建入口后重新分享") }
            else { setStatus("本地管理就绪 · \(rooms) 条共享") }
        }
        if type == "error" { message(object["message"] as? String ?? "操作失败，请重试。") }
        if type == "result", object["command"] as? String == "account", object["authenticated"] as? Bool == false {
            setStatus("尚未登录独立账号 · 点击“独立账号登录”")
        }
        if type == "result", object["attached"] as? Bool == true {
            setStatus("已连接日常 Codex · 右键选择会话即可分享")
        }
        if type == "result", object["command"] as? String == "connect-current" {
            setStatus("已连接当前 Codex · 在管理页选择会话")
        }
        if type == "result", object["command"] as? String == "login", let raw = object["authUrl"] as? String,
           let url = URL(string: raw), url.scheme == "https", ["auth.openai.com", "auth0.openai.com", "chatgpt.com"].contains(url.host ?? "") {
            NSWorkspace.shared.open(url); setStatus("请在浏览器完成独立登录")
        }
        if type == "login-completed" { setStatus(object["success"] as? Bool == true ? "独立账号已登录，请刷新会话列表" : "登录未完成，请重试") }
    }
    func updateAttention(_ items: [[String: Any]]) {
        var current: [String: [String: Any]] = [:]
        for item in items {
            guard let id = item["id"] as? String, id.count < 200,
                  let kind = item["kind"] as? String, attentionTitles[kind] != nil,
                  let members = item["members"] as? [String], !members.isEmpty else { continue }
            current[id] = item
        }
        let removed = Set(attention.keys).subtracting(current.keys)
        let center = UNUserNotificationCenter.current()
        center.removeDeliveredNotifications(withIdentifiers: Array(removed))
        center.removePendingNotificationRequests(withIdentifiers: Array(removed))
        attention = current
        if !attention.isEmpty && !requestedNotifications && !notificationsAllowed { requestNotifications() }
        syncAttentionNotifications()
        openPendingAttention()
    }
    func requestNotifications() {
        guard !requestingNotifications else { return }
        requestedNotifications = true; requestingNotifications = true
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            DispatchQueue.main.async {
                self.requestingNotifications = false; self.notificationsAllowed = granted
                if granted { self.syncAttentionNotifications() }
            }
        }
    }
    func syncAttentionNotifications() {
        NSApp.dockTile.badgeLabel = attention.isEmpty ? nil : String(attention.values.reduce(0) { $0 + ($1["count"] as? Int ?? 1) })
        let changed = notificationLedger.reconcile(attention.mapValues { Set($0["members"] as? [String] ?? []) }, enabled: notificationsAllowed)
        for id in changed {
            guard let item = attention[id], let kind = item["kind"] as? String else { continue }
            let content = UNMutableNotificationContent()
            content.title = localized(attentionTitles[kind] ?? "协作通知")
            content.body = localized(kind == "tool" ? "点击查看对应共享，工具审批仍需在 Codex 中处理。" : "点击打开 Codex Co²，查看并处理对应事项。")
            content.sound = .default; content.threadIdentifier = item["roomId"] as? String ?? "manager"
            content.userInfo = ["attentionID": id]
            UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: content, trigger: nil)) { _ in
                DispatchQueue.main.async {
                    if self.attention[id] == nil { UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [id]) }
                }
            }
        }
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let id = response.notification.request.content.userInfo["attentionID"] as? String
        DispatchQueue.main.async {
            if response.actionIdentifier == UNNotificationDefaultActionIdentifier, let id = id {
                self.pendingAttentionID = id; self.showWindow(); self.openPendingAttention()
            }
            completionHandler()
        }
    }
    func openPendingAttention() {
        guard let id = pendingAttentionID, let owner = ownerURL, let current = webView?.url,
              current.scheme == owner.scheme, current.host == owner.host, current.port == owner.port,
              let bytes = try? JSONSerialization.data(withJSONObject: [id]), let json = String(data: bytes, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.openCo2Attention?.(\(json)[0])") { result, _ in
            if result as? Bool == true && self.pendingAttentionID == id { self.pendingAttentionID = nil }
        }
    }
    @objc func openDesktop() { send("open-desktop") }
    @objc func connectCurrent() {
        if helper == nil { launchHelper() } else { send("connect-current") }
    }
    @objc func login() { send("login") }
    @objc func revokeAll() { send("revoke-all") }
    func stopHelper() { serviceStopRequested = true; send("shutdown") }
    @objc func retry() {
        if helper != nil { message("助手仍在运行。请先退出应用，再重新打开。"); return }
        launchHelper()
    }
    @objc func selectRuntime() {
        let panel = NSOpenPanel(); panel.canChooseFiles = false; panel.canChooseDirectories = true; panel.showsHiddenFiles = true
        panel.message = localized("选择已有的独立 .coop 目录。此操作不搬迁或合并数据；请先停止使用它的其他助手。")
        guard panel.runModal() == .OK, let url = panel.url else { return }
        guard url.lastPathComponent == ".coop" else { message("请选择名为 .coop 的独立运行目录。"); return }
        changingRuntime = true
        // Changing the runtime is an explicit ownership boundary. Revoke old
        // sharing before a second runtime can become active.
        if helper?.isRunning == true { send("revoke-all") }
        beginHelperShutdown(forceOnTimeout: false) { [weak self] success in
            guard let self = self else { return }
            guard success else { self.changingRuntime = false; self.message("无法停止本地助手，运行目录未更改。"); return }
            self.unregisterBackground { stopped in
                self.changingRuntime = false
                guard stopped else { self.message("无法停止后台启动，运行目录未更改。"); return }
                do {
                    try BackgroundConfiguration.saveRuntime(url)
                    self.message("运行目录已保存。退出并重新打开应用后生效。")
                } catch { self.message("无法保存运行目录，请检查目录权限。") }
            }
        }
    }
    @objc func quit() { NSApp.terminate(nil) }
    func didStopHelper(_ process: Process, generation: Int) {
        guard helperGeneration == generation, helper === process else { return }
        output?.fileHandleForReading.readabilityHandler = nil
        if let handle = output?.fileHandleForReading, let remaining = try? handle.readToEnd(), !remaining.isEmpty { consumeOutput(remaining) }
        helper = nil; ownerURL = nil
        input = nil; output = nil
        startupRetry?.isEnabled = managedStartAttempt == nil
        updateAttention([]); activeRooms = 0
        let wasConnected = bridgeConnected; bridgeConnected = false; backgroundActive = false
        let wasStopping = helperStopToken != nil
        if wasStopping {
            // Pipe readability callbacks already queued on the main thread may
            // contain the final acknowledgement. Check after those callbacks.
            DispatchQueue.main.async { [weak self] in
                guard let self = self else { return }
                if self.serviceStoppedConfirmed { self.waitForForegroundExit() }
                else { self.finishHelperShutdown(false) }
            }
        }
        let intentionalStop = wasStopping || serviceStopRequested || serviceStoppedConfirmed || startupFailure != nil || exiting
            || changingRuntime || updates.installationAuthorized
        let managedAvailable = usingManagedService && backgroundEnabled && backgroundRegistration.status == "enabled"
        if let delay = BackgroundBridgePolicy.reconnectDelay(attempt: bridgeLaunchAttempts, wasConnected: wasConnected,
                                                             managedAvailable: managedAvailable, intentionalStop: intentionalStop) {
            publishBackground()
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let self = self, self.helperGeneration == generation, !self.serviceStopRequested else { return }
                self.launchBridge()
            }
            return
        }
        publishBackground()
        if !exiting && startupFailure == nil {
            startupAttempt = nil
            if managerOrigin == nil && !intentionalStop { failStartup("本地服务未能启动。请检查运行目录权限或重新连接助手。") }
            else { setStatus("助手已停止，可从菜单栏重新连接"); setStatusTitle("Co² · 已停止") }
        }
    }
    func beginHelperShutdown(forceOnTimeout: Bool, completion: @escaping (Bool) -> Void) {
        serviceStopRequested = true; startupAttempt = nil
        guard managedStartAttempt == nil else { completion(false); return }
        guard let process = helper, process.isRunning, bridgeConnected else {
            // A missing bridge does not prove the independent service stopped.
            completion(serviceStoppedConfirmed || (!usingManagedService && foregroundDaemon?.isRunning != true)); return
        }
        let generation = helperGeneration
        helperStopWaiters.append(completion); helperStopForce = helperStopForce || forceOnTimeout
        guard helperStopToken == nil else { return }
        let token = UUID(); helperStopToken = token; serviceStoppedConfirmed = false
        send("shutdown")
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
            guard let self = self, self.helperStopToken == token else { return }
            if !process.isRunning { self.didStopHelper(process, generation: generation); return }
            // Killing the bridge cannot prove its independent service stopped.
            // Leave the application/update open when graceful cleanup fails.
            self.finishHelperShutdown(false)
        }
    }
    func finishHelperShutdown(_ success: Bool) {
        helperStopToken = nil; helperStopForce = false
        let waiters = helperStopWaiters; helperStopWaiters.removeAll()
        for callback in waiters { callback(success) }
    }
    func waitForForegroundExit(attempt: Int = 0) {
        guard helperStopToken != nil else { return }
        if foregroundDaemon?.isRunning != true { foregroundDaemon = nil; finishHelperShutdown(true); return }
        if attempt >= 100 { finishHelperShutdown(false); return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in self?.waitForForegroundExit(attempt: attempt + 1) }
    }
    func prepareUpdateInstallation(_ completion: @escaping (UpdatePreparationResult) -> Void) {
        if helper?.isRunning == true && activeRooms != 0 {
            let alert = NSAlert(); alert.messageText = localized("结束共享并更新")
            alert.informativeText = localized("更新会暂时停止共享服务并重新打开 Co²。内网原地址可用时可申请恢复；公网临时链接需要重新分享。")
            alert.addButton(withTitle: localized("结束共享并更新")); alert.addButton(withTitle: localized("取消"))
            guard alert.runModal() == .alertFirstButtonReturn else { completion(.cancelled); return }
        }
        beginHelperShutdown(forceOnTimeout: false) { [weak self] success in
            guard let self = self, success else { completion(.failed); return }
            // Stop login/retry ownership before Sparkle replaces Resources.
            self.unregisterBackground { stopped in completion(stopped ? .ready : .failed) }
        }
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if updates.preventsTermination {
            updates.cancel(); setStatus("更新正在取消，请稍后再次退出。"); return .terminateCancel
        }
        if backgroundSaveID != nil { setStatus("正在保存后台设置，请稍后再次退出。"); return .terminateCancel }
        if backgroundEnabled && managedStartupRequired && helper == nil && foregroundDaemon?.isRunning != true && !updates.installationAuthorized {
            // Startup never acquired a manager connection. Quit may cancel its
            // registration transaction, but does not claim the service stopped.
            exiting = true; serviceStopRequested = true; startupAttempt = nil
            return .terminateNow
        }
        if backgroundEnabled && usingManagedService && backgroundRegistration.status == "enabled" && !updates.installationAuthorized {
            exiting = true
            // Closing only our pipe detaches the bridge. launchd owns sharing.
            try? input?.fileHandleForWriting.close()
            return .terminateNow
        }
        if helper?.isRunning != true && !usingManagedService && foregroundDaemon?.isRunning != true { return .terminateNow }
        if !backgroundEnabled && (helper?.isRunning != true || !bridgeConnected) {
            exiting = true
            unregisterBackground { [weak self] stopped in
                if !stopped { self?.exiting = false }
                NSApp.reply(toApplicationShouldTerminate: stopped)
            }
            return .terminateLater
        }
        exiting = true
        beginHelperShutdown(forceOnTimeout: true) { [weak self] success in
            guard let self = self else { NSApp.reply(toApplicationShouldTerminate: false); return }
            if !success { self.exiting = false; NSApp.reply(toApplicationShouldTerminate: false); return }
            if !self.backgroundEnabled {
                self.unregisterBackground { stopped in
                    if !stopped { self.exiting = false }
                    NSApp.reply(toApplicationShouldTerminate: stopped)
                }
            } else { NSApp.reply(toApplicationShouldTerminate: true) }
        }
        return .terminateLater
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let target = action.request.url, let owner = ownerURL,
              target.scheme == owner.scheme, target.host == owner.host, target.port == owner.port else { decisionHandler(.cancel); return }
        decisionHandler(.allow)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let owner = ownerURL, let current = webView.url,
              current.scheme == owner.scheme, current.host == owner.host, current.port == owner.port,
              let bytes = try? JSONSerialization.data(withJSONObject: [NSFullUserName()], options: []),
              let argument = String(data: bytes, encoding: .utf8) else { return }
        // The existing Desktop interface exposes no account display name.
        // Use the local macOS name without reading Codex credentials or profiles.
        webView.evaluateJavaScript("window.setCo2SuggestedName?.(\(argument)[0])", completionHandler: nil)
        publishUpdates()
        publishBackground()
        if pendingAbout { showAboutPage() }
        openPendingAttention()
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        // Language is a local preference and remains editable if the helper stops.
        // Invitation copying still requires the currently active owner endpoint.
        guard message.frameInfo.isMainFrame, message.webView === webView,
              let owner = ["languagePreference", "appUpdates"].contains(message.name) ? managerOrigin : ownerURL,
              message.frameInfo.securityOrigin.protocol == owner.scheme,
              message.frameInfo.securityOrigin.host == owner.host,
              message.frameInfo.securityOrigin.port == owner.port else { return }
        if message.name == "appUpdates" {
            guard let object = message.body as? [String: Any] else { return }
            updates.handle(object); return
        }
        if message.name == "backgroundService", let (action, enabled) = BackgroundConfiguration.action(message.body) {
            if action == "set", let enabled = enabled { changeBackground(enabled) }
            else if action == "settings" { backgroundRegistration.openSettings() }
            else { publishBackground() }
            return
        }
        if message.name == "languagePreference" {
            guard let value = message.body as? String, ["zh-CN", "zh-TW", "en"].contains(value) else { return }
            language = value; UserDefaults.standard.set(value, forKey: "interfaceLanguage")
            installLanguageScript(webView.configuration.userContentController)
            buildMenus(); setStatus(statusSource); return
        }
        if message.name == "notificationSettings", message.body as? String == "enable" {
            UNUserNotificationCenter.current().getNotificationSettings { settings in DispatchQueue.main.async {
                if settings.authorizationStatus == .denied {
                    if let url = URL(string: "x-apple.systempreferences:com.apple.preference.notifications") { NSWorkspace.shared.open(url) }
                } else { self.requestNotifications() }
            } }
            return
        }
        guard message.name == "copyInvite", let result = InvitationClipboard.response(to: message.body),
              let bytes = try? JSONSerialization.data(withJSONObject: result), let json = String(data: bytes, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.co2InviteCopyResult?.(\(json))", completionHandler: nil)
    }
}
@main
enum CodexCo2Application {
    static func main() {
        if BackgroundConfiguration.runAgentIfRequested() { return }
        let delegate = AppDelegate()
        let application = NSApplication.shared
        application.delegate = delegate
        withExtendedLifetime(delegate) { application.run() }
    }
}
