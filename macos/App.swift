import AppKit
import WebKit
import CryptoKit
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
    var sequence = 0
    var helperGeneration = 0
    var tunnelProcesses: [Int32: String] = [:]
    var attention: [String: [String: Any]] = [:]
    var notificationLedger = AttentionLedger()
    var notificationsAllowed = false
    var requestingNotifications = false
    var requestedNotifications = false
    var pendingAttentionID: String?
    let attentionTitles = ["guest": "访客申请加入", "proposal": "协作消息待审批", "tool": "Codex 工具等待审批",
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
        guard let bytes = try? JSONSerialization.data(withJSONObject: [language]), let json = String(data: bytes, encoding: .utf8) else { return }
        controller.removeAllUserScripts()
        controller.addUserScript(WKUserScript(source: "window.co2Language = \(json)[0];", injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }
    var defaultRuntimeDir: String {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Codex Co²/.coop").path
    }
    var runtimeDir: String {
        let args = CommandLine.arguments
        if let i = args.firstIndex(of: "--runtime-dir"), i + 1 < args.count { return args[i + 1] }
        if let bytes = try? Data(contentsOf: URL(fileURLWithPath: defaultRuntimeDir).appendingPathComponent("app-settings.json")),
           let settings = try? JSONSerialization.jsonObject(with: bytes) as? [String: String],
           let selected = settings["runtimeDirectory"] { return selected }
        return defaultRuntimeDir
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        if let bundleID = Bundle.main.bundleIdentifier,
           let existing = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).first(where: { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }) {
            DistributedNotificationCenter.default().postNotificationName(Notification.Name("local.codexco2.manager.show"), object: nil)
            existing.activate(options: [.activateAllWindows]); NSApp.terminate(nil); return
        }
        NSApp.setActivationPolicy(.regular)
        buildMenus(); buildWindow(); showWindow(); launchHelper()
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
        UNUserNotificationCenter.current().getNotificationSettings { settings in DispatchQueue.main.async {
            self.notificationsAllowed = settings.authorizationStatus == .authorized
            self.syncAttentionNotifications()
        } }
    }
    func buildMenus() {
        let main = NSMenu(); let appItem = NSMenuItem(); let appMenu = NSMenu()
        appMenu.addItem(withTitle: localized("关于 Codex Co²"), action: #selector(about), keyEquivalent: "")
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
        installLanguageScript(config.userContentController)
        webView = WKWebView(frame: .zero, configuration: config); webView.navigationDelegate = self; webView.uiDelegate = self
        for view in [statusLabel!, webView!] {
            view.translatesAutoresizingMaskIntoConstraints = false; root.addSubview(view)
        }
        window.contentView = root
        NSLayoutConstraint.activate([
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
        let alert = NSAlert(); alert.messageText = "Codex Co²"
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
        let versionLabel = localized("版本 {version}（{build}）").replacingOccurrences(of: "{version}", with: version).replacingOccurrences(of: "{build}", with: build)
        alert.informativeText = [versionLabel, "Real-time collaboration for Codex", localized("共享一条 Codex 会话，一起推进工作。"), "",
                                 localized("Apple Silicon 内部试用包 · 未公证"), localized("连接日常 Codex，默认直接接收协作消息，可按会话开启审批。")].joined(separator: "\n")
        alert.runModal()
    }
    func message(_ text: String) { setStatus(text); let alert = NSAlert(); alert.messageText = "Codex Co²"; alert.informativeText = localized(text); alert.runModal() }

    func launchHelper() {
        guard helper == nil, let resources = Bundle.main.resourceURL else { return }
        guard !CommandLine.arguments.contains("--isolated") else {
            let explanation = "此安装包仅支持连接日常 Codex。隔离实验请从源码运行。"
            setStatus(explanation); message(explanation); return
        }
        ownerURL = nil; helperGeneration += 1; let generation = helperGeneration
        setStatus("正在启动本地管理…"); setStatusTitle("Co² · 启动中")
        let service = resources.appendingPathComponent("service")
        let binaries = resources.appendingPathComponent("runtime")
        let process = Process(); process.executableURL = binaries.appendingPathComponent("node")
        process.arguments = [service.appendingPathComponent("bin/desktop-service.mjs").path, "--resource-root", service.path,
                             "--runtime-dir", runtimeDir, "--attach",
                             "--cloudflared", binaries.appendingPathComponent("cloudflared").path]
        if let official = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.openai.codex") {
            process.arguments?.append(contentsOf: ["--desktop-app", official.path])
        }
        process.currentDirectoryURL = resources
        let env = ProcessInfo.processInfo.environment
        var clean = ["PATH": binaries.path + ":/usr/bin:/bin:/usr/sbin:/sbin", "HOME": FileManager.default.homeDirectoryForCurrentUser.path,
                     "LANG": env["LANG"] ?? "en_US.UTF-8"]
        for key in ["USER", "LOGNAME", "TMPDIR"] { if let value = env[key] { clean[key] = value } }
        process.environment = clean
        let stdinPipe = Pipe(), stdoutPipe = Pipe(); process.standardInput = stdinPipe; process.standardOutput = stdoutPipe
        process.standardError = FileHandle.nullDevice // Never log capabilities, authentication URLs or backend diagnostics.
        input = stdinPipe; output = stdoutPipe; outputBuffer = Data()
        stdoutPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            DispatchQueue.main.async {
                guard let self = self, self.helperGeneration == generation else { return }
                if data.isEmpty { handle.readabilityHandler = nil; return }
                self.outputBuffer.append(data)
                if self.outputBuffer.count > 131072 { self.stopHelper(); self.message("助手返回了无效数据，请重新连接。"); return }
                while let newline = self.outputBuffer.firstIndex(of: 10) {
                    let line = self.outputBuffer[..<newline]; self.outputBuffer.removeSubrange(...newline)
                    if let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any] { self.receive(object) }
                }
            }
        }
        process.terminationHandler = { [weak self] _ in DispatchQueue.main.async {
            guard let self = self, self.helperGeneration == generation else { return }
            self.output?.fileHandleForReading.readabilityHandler = nil; self.helper = nil; self.ownerURL = nil
            self.updateAttention([])
            self.retireOrphanTunnels()
            if self.exiting { NSApp.reply(toApplicationShouldTerminate: true) }
            else { self.setStatus("助手已停止，可从菜单栏重新连接"); self.setStatusTitle("Co² · 已停止") }
        } }
        do { helper = process; try process.run() }
        catch { helper = nil; setStatus("启动失败"); message("无法启动内置助手。请重新安装完整的应用包。"); }
    }
    func send(_ command: String) {
        guard helper?.isRunning == true, let input = input else { message("助手未连接，请从菜单栏重新连接。"); return }
        sequence += 1
        if let data = try? JSONSerialization.data(withJSONObject: ["type": command, "id": sequence]) {
            do { try input.fileHandleForWriting.write(contentsOf: data + Data([10])) } catch { setStatus("助手已断开") }
        }
    }
    func receive(_ object: [String: Any]) {
        let type = object["type"] as? String ?? ""
        if type == "resource", object["kind"] as? String == "tunnel", let pid = object["pid"] as? Int32,
           pid > 1, let fingerprint = object["fingerprint"] as? String, fingerprint.count == 64 {
            tunnelProcesses[pid] = fingerprint
            if helper?.isRunning != true { retireOrphanTunnels() }
        }
        if type == "ready", let raw = object["ownerUrl"] as? String, let url = URL(string: raw), url.scheme == "http", url.host == "127.0.0.1", url.port != nil {
            ownerURL = url; managerOrigin = url; webView.load(URLRequest(url: url)); send("account"); return
        }
        if type == "status" {
            if let items = object["attention"] as? [[String: Any]] { updateAttention(items) }
            let phase = object["phase"] as? String ?? "starting", rooms = object["rooms"] as? Int ?? 0, pending = object["pending"] as? Int ?? 0
            let network = (object["connection"] as? [String: Any])?["state"] as? String ?? ""
            setStatusTitle(pending > 0 ? "Co² · 待确认 \(pending)" : rooms > 0 ? "Co² · 共享 \(rooms)" : "Co²")
            if phase == "stopped" { updateAttention([]); setStatus("共享已停止") }
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
    func retireOrphanTunnels() {
        for (pid, fingerprint) in tunnelProcesses {
            let check = Process(), pipe = Pipe(); check.executableURL = URL(fileURLWithPath: "/bin/ps")
            check.arguments = ["-p", String(pid), "-o", "lstart=", "-o", "command="]; check.standardOutput = pipe; check.standardError = FileHandle.nullDevice
            guard (try? check.run()) != nil else { continue }
            let bytes = pipe.fileHandleForReading.readDataToEndOfFile(); check.waitUntilExit()
            let identity = String(data: bytes, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let current = SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
            if current == fingerprint, identity.contains("/runtime/cloudflared tunnel ") { Darwin.kill(pid, SIGTERM) }
        }
        tunnelProcesses.removeAll()
    }
    @objc func login() { send("login") }
    @objc func revokeAll() { send("revoke-all") }
    func stopHelper() { send("shutdown") }
    @objc func retry() {
        if helper != nil { message("助手仍在运行。请先退出应用，再重新打开。"); return }
        launchHelper()
    }
    @objc func selectRuntime() {
        let panel = NSOpenPanel(); panel.canChooseFiles = false; panel.canChooseDirectories = true; panel.showsHiddenFiles = true
        panel.message = localized("选择已有的独立 .coop 目录。此操作不搬迁或合并数据；请先停止使用它的其他助手。")
        guard panel.runModal() == .OK, let url = panel.url else { return }
        guard url.lastPathComponent == ".coop" else { message("请选择名为 .coop 的独立运行目录。"); return }
        do {
            try FileManager.default.createDirectory(atPath: defaultRuntimeDir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let target = URL(fileURLWithPath: defaultRuntimeDir).appendingPathComponent("app-settings.json")
            let bytes = try JSONSerialization.data(withJSONObject: ["runtimeDirectory": url.resolvingSymlinksInPath().path])
            try bytes.write(to: target, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: target.path)
            message("运行目录已保存。退出并重新打开应用后生效。")
        } catch { message("无法保存运行目录，请检查目录权限。") }
    }
    @objc func quit() { NSApp.terminate(nil) }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if helper?.isRunning != true { return .terminateNow }
        exiting = true; send("shutdown")
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
            if self?.helper?.isRunning == true { self?.helper?.terminate() }
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
        openPendingAttention()
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        // Language is a local preference and remains editable if the helper stops.
        // Invitation copying still requires the currently active owner endpoint.
        guard message.frameInfo.isMainFrame, let owner = message.name == "languagePreference" ? managerOrigin : ownerURL,
              message.frameInfo.securityOrigin.protocol == owner.scheme,
              message.frameInfo.securityOrigin.host == owner.host,
              message.frameInfo.securityOrigin.port == owner.port else { return }
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
let delegate = AppDelegate()
let application = NSApplication.shared
application.delegate = delegate
application.run()
