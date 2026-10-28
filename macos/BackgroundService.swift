import AppKit
import ServiceManagement
import CoreFoundation
import CryptoKit
import Security

enum BackgroundConfigurationError: Error {
    case invalidPrivateFile
    case invalidSettings
    case invalidRuntime
    case unavailableBundle
    case registrationUnavailable
}

enum BackgroundSigningStatus: Equatable {
    case adHoc
    case identified
    case unavailable
}

struct BackgroundSigningPolicy {
    static func classify(flags: UInt32?, teamIdentifier: String?) -> BackgroundSigningStatus {
        guard let flags = flags else { return .unavailable }
        if flags & SecCodeSignatureFlags.adhoc.rawValue != 0 { return .adHoc }
        guard let team = teamIdentifier,
              team.range(of: "^[A-Za-z0-9]{1,64}$", options: .regularExpression) != nil else { return .unavailable }
        return .identified
    }
    static func current() -> BackgroundSigningStatus {
        // This is capability metadata, not authorization or proof that launchd
        // will accept a registration. Invalid/unknown signatures fail closed.
        var code: SecCode?, staticCode: SecStaticCode?, information: CFDictionary?
        let defaults = SecCSFlags()
        guard SecCodeCopySelf(defaults, &code) == errSecSuccess, let code = code,
              SecCodeCheckValidity(code, .noNetworkAccess, nil) == errSecSuccess,
              SecCodeCopyStaticCode(code, defaults, &staticCode) == errSecSuccess, let staticCode = staticCode,
              SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
              let data = information as? [String: Any] else { return .unavailable }
        return classify(flags: (data[kSecCodeInfoFlags as String] as? NSNumber)?.uint32Value,
                        teamIdentifier: data[kSecCodeInfoTeamIdentifier as String] as? String)
    }
}

enum BackgroundStartResult: Equatable {
    case started
    case foreground
    case missing
    case cancelled
    case failed(Int32)
    case timedOut
    case launchFailed
    case unverified
    case registrationFailed
    case requiresApproval
}

struct BackgroundLaunchPolicy {
    // BTM can still report enabled after launchd has lost the job. Repair that
    // registration once; never start a foreground daemon that would discard
    // the managed service's persistent invitation recovery state.
    static func start(shouldContinue: @escaping () -> Bool,
                      kickstart: @escaping (@escaping (BackgroundStartResult) -> Void) -> Void,
                      repair: @escaping (@escaping (Bool) -> Void) -> Void,
                      completion: @escaping (BackgroundStartResult) -> Void) {
        guard shouldContinue() else { completion(.cancelled); return }
        kickstart { result in
            guard shouldContinue() else { completion(.cancelled); return }
            guard result == .missing else { completion(result); return }
            repair { repaired in
                guard shouldContinue() else { completion(.cancelled); return }
                guard repaired else { completion(.missing); return }
                kickstart { result in completion(shouldContinue() ? result : .cancelled) }
            }
        }
    }
    static func runKickstart(arguments: [String], completion: @escaping (BackgroundStartResult) -> Void) {
        BackgroundCommand.run(arguments: arguments) { result in
            switch result {
            case .exited(0, _): completion(.started)
            case .exited(113, _): completion(.missing)
            case .exited(let status, _): completion(.failed(status))
            case .timedOut: completion(.timedOut)
            case .launchFailed: completion(.launchFailed)
            case .unverified: completion(.unverified)
            }
        }
    }
}

// Read launchctl's own job metadata, never arguments, credentials or arbitrary
// log output. An enabled BTM item is not evidence of a running launchd job.
enum BackgroundJobState: Equatable {
    case running(Int32)
    case inactive(failed: Bool)
    case missing
    case unavailable(BackgroundStartResult)

    static func parse(status: Int32, output: String) -> BackgroundJobState {
        if status == 113 { return .missing }
        guard status == 0 else { return .unavailable(.failed(status)) }
        var fields: [String: String] = [:]
        for line in output.split(separator: "\n") {
            guard line.hasPrefix("\t"), !line.hasPrefix("\t\t") else { continue }
            let parts = line.dropFirst().components(separatedBy: " = ")
            if parts.count == 2, ["pid", "state", "job state", "last exit reason", "last exit code"].contains(parts[0]) {
                guard fields[parts[0]] == nil else { return .unavailable(.unverified) }
                fields[parts[0]] = parts[1]
            }
        }
        if let raw = fields["pid"] {
            guard let pid = Int32(raw), pid > 1 else { return .unavailable(.unverified) }
            return .running(pid)
        }
        // Historical failure fields can survive while a new process is
        // spawning. Only a positively idle current state permits teardown.
        guard let state = fields["state"], ["waiting", "not running", "exited", "spawn scheduled"].contains(state) else {
            return .unavailable(.unverified)
        }
        let failed = fields["job state"] == "spawn failed"
            || fields["last exit reason"]?.contains("OS_REASON_CODESIGNING") == true
            || fields["last exit code"]?.hasPrefix("78:") == true
        if failed { return .inactive(failed: true) }
        guard state != "spawn scheduled" else { return .unavailable(.unverified) }
        return .inactive(failed: false)
    }
}

enum BackgroundCommandResult {
    case exited(Int32, String)
    case timedOut
    case launchFailed
    case unverified
}

struct BackgroundCommand {
    static func run(arguments: [String], executable: URL = URL(fileURLWithPath: "/bin/launchctl"),
                    timeout: TimeInterval = 5, completion: @escaping (BackgroundCommandResult) -> Void) {
        let task = Process(); task.executableURL = executable; task.arguments = arguments
        let output = Pipe()
        task.standardInput = FileHandle.nullDevice; task.standardOutput = output; task.standardError = FileHandle.nullDevice
        var finished = false, exited = false, read = false, invalid = false, timedOut = false
        var bytes = Data()
        func finish(_ result: BackgroundCommandResult) {
            guard !finished else { return }; finished = true; completion(result)
        }
        func collect() {
            guard exited else { return }
            if timedOut { finish(.timedOut); return }
            guard read else { return }
            guard !invalid, task.terminationReason == .exit, let text = String(data: bytes, encoding: .utf8) else {
                finish(.unverified); return
            }
            finish(.exited(task.terminationStatus, text))
        }
        task.terminationHandler = { _ in DispatchQueue.main.async { exited = true; collect() } }
        do { try task.run(); try? output.fileHandleForWriting.close() }
        catch { try? output.fileHandleForWriting.close(); try? output.fileHandleForReading.close(); finish(.launchFailed); return }
        DispatchQueue.global(qos: .utility).async {
            var collected = Data(), failed = false
            do {
                while let chunk = try output.fileHandleForReading.read(upToCount: 4096), !chunk.isEmpty {
                    guard collected.count + chunk.count <= 65536 else { failed = true; break }
                    collected.append(chunk)
                }
            } catch { failed = true }
            try? output.fileHandleForReading.close()
            let result = collected, didFail = failed
            DispatchQueue.main.async {
                bytes = result; invalid = didFail; read = true
                if didFail && task.isRunning { task.terminate() }
                collect()
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) {
            guard !finished else { return }
            timedOut = true
            // Settle only after this owned launchctl process has exited. A
            // timed-out mutating command must not race a subsequent attempt.
            if task.isRunning { task.terminate() }
            else { exited = true; collect() }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                if task.isRunning { Darwin.kill(task.processIdentifier, SIGKILL) }
            }
        }
    }
}

struct BackgroundPreflightPolicy {
    static func start(identityMatches: Bool, allowManaged: Bool = true, registration: @escaping () -> SMAppService.Status,
                      shouldContinue: @escaping () -> Bool,
                      inspect: @escaping (@escaping (BackgroundJobState) -> Void) -> Void,
                      bootout: @escaping (@escaping (BackgroundStartResult) -> Void) -> Void,
                      unregister: @escaping (@escaping (Bool) -> Void) -> Void,
                      register: @escaping () throws -> Void,
                      settle: @escaping (TimeInterval, @escaping () -> Void) -> Void,
                      registered: @escaping () -> Void,
                      kickstart: @escaping (@escaping (BackgroundStartResult) -> Void) -> Void,
                      completion: @escaping (BackgroundStartResult) -> Void) {
        func active() -> Bool {
            if shouldContinue() { return true }; completion(.cancelled); return false
        }
        func launch() {
            guard active() else { return }
            kickstart { result in completion(shouldContinue() ? result : .cancelled) }
        }
        guard active() else { return }
        inspect { job in
            guard active() else { return }
            if case .running = job { completion(.started); return }
            if case .unavailable(let error) = job { completion(error); return }
            guard !allowManaged || registration() != .requiresApproval else { completion(.requiresApproval); return }
            let failed = job == .inactive(failed: true)
            let refresh = !allowManaged || !identityMatches || failed || job == .missing || registration() != .enabled
            guard refresh else { launch(); return }
            // Recheck just before removing a job. A newly available service is
            // reused; unknown or active jobs never authorize a destructive repair.
            inspect { current in
                guard active() else { return }
                if case .running = current { completion(.started); return }
                if case .unavailable(let error) = current { completion(error); return }
                func detach() {
                    guard active() else { return }
                    unregister { removed in
                        guard active() else { return }
                        guard removed else { completion(.registrationFailed); return }
                        // The GUI may own a foreground service only after old
                        // system ownership has been removed. Persistent recovery
                        // preferences and records are intentionally untouched.
                        if !allowManaged { completion(.foreground); return }
                        // A failed code-sign launch schedules a BTM invalidation
                        // at its launchd throttle interval. Let it settle before
                        // binding the replacement, rather than reviving that job.
                        settle(failed || current == .inactive(failed: true) ? 10.5 : 0.25) {
                            guard active() else { return }
                            do { try register() } catch {
                                completion(registration() == .requiresApproval ? .requiresApproval : .registrationFailed); return
                            }
                            guard registration() == .enabled else {
                                completion(registration() == .requiresApproval ? .requiresApproval : .registrationFailed); return
                            }
                            registered(); launch()
                        }
                    }
                }
                if current == .missing { detach(); return }
                bootout { result in
                    guard active() else { return }
                    guard result == .started || result == .missing else { completion(result); return }
                    detach()
                }
            }
        }
    }
}

struct BackgroundRegistrationIdentity: Equatable {
    let bundlePath: String
    let executableSHA256: String
    let plistSHA256: String
    static let fileName = "background-registration.json"
    static func capture(bundle: Bundle = .main) throws -> BackgroundRegistrationIdentity {
        guard let executable = bundle.executableURL else { throw BackgroundConfigurationError.unavailableBundle }
        let root = bundle.bundleURL.resolvingSymlinksInPath().standardizedFileURL
        func digest(_ url: URL) throws -> String { SHA256.hash(data: try Data(contentsOf: url)).map { String(format: "%02x", $0) }.joined() }
        return try BackgroundRegistrationIdentity(bundlePath: root.path, executableSHA256: digest(executable),
            plistSHA256: digest(root.appendingPathComponent("Contents/Library/LaunchAgents/" + BackgroundConfiguration.plistName)))
    }
    static func read(runtime: URL) throws -> BackgroundRegistrationIdentity? {
        guard let value = try BackgroundConfiguration.privateJSON(runtime.appendingPathComponent(fileName)) else { return nil }
        guard Set(value.keys) == Set(["version", "bundlePath", "executableSHA256", "plistSHA256"]),
              !BackgroundConfiguration.isBoolean(value["version"]), value["version"] as? Int == 1,
              let bundle = value["bundlePath"] as? String, bundle.hasPrefix("/"), !bundle.contains("\0"), bundle.utf8.count < 2048,
              let executable = value["executableSHA256"] as? String, let plist = value["plistSHA256"] as? String,
              [executable, plist].allSatisfy({ $0.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil }) else {
            throw BackgroundConfigurationError.invalidPrivateFile
        }
        return BackgroundRegistrationIdentity(bundlePath: bundle, executableSHA256: executable, plistSHA256: plist)
    }
    func save(runtime: URL) throws {
        var info = stat()
        guard lstat(runtime.path, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR,
              info.st_uid == geteuid(), (info.st_mode & 0o077) == 0 else { throw BackgroundConfigurationError.invalidPrivateFile }
        _ = try Self.read(runtime: runtime)
        let data: [String: Any] = ["version": 1, "bundlePath": bundlePath, "executableSHA256": executableSHA256, "plistSHA256": plistSHA256]
        let bytes = try JSONSerialization.data(withJSONObject: data)
        guard bytes.count <= 4096 else { throw BackgroundConfigurationError.invalidPrivateFile }
        let file = runtime.appendingPathComponent(Self.fileName)
        let temporary = runtime.appendingPathComponent("background-registration.\(UUID().uuidString).tmp")
        let fd = Darwin.open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw BackgroundConfigurationError.invalidPrivateFile }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        defer { try? handle.close(); try? FileManager.default.removeItem(at: temporary) }
        try handle.write(contentsOf: bytes)
        guard fsync(fd) == 0, Darwin.rename(temporary.path, file.path) == 0 else { throw BackgroundConfigurationError.invalidPrivateFile }
        let directory = Darwin.open(runtime.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        guard directory >= 0 else { throw BackgroundConfigurationError.invalidPrivateFile }
        defer { Darwin.close(directory) }
        guard fsync(directory) == 0 else { throw BackgroundConfigurationError.invalidPrivateFile }
    }
}

final class BackgroundRegistrationReceipt {
    private var pending: (URL, BackgroundRegistrationIdentity)?
    func clear() { pending = nil }
    func stage(runtime: URL, identity: BackgroundRegistrationIdentity) { pending = (runtime.standardizedFileURL, identity) }
    func confirmReady(runtime: URL, currentIdentity: () throws -> BackgroundRegistrationIdentity) throws {
        guard let (selected, identity) = pending, selected == runtime.standardizedFileURL else { return }
        pending = nil
        guard try currentIdentity() == identity else { throw BackgroundConfigurationError.unavailableBundle }
        try identity.save(runtime: runtime)
    }
}

struct BackgroundRegistrationPolicy {
    static func registerIfNeeded(status: () -> SMAppService.Status, register: () throws -> Void) throws {
        switch status() {
        case .enabled, .requiresApproval: return
        case .notRegistered, .notFound: try register()
        @unknown default: throw BackgroundConfigurationError.registrationUnavailable
        }
        guard status() == .enabled || status() == .requiresApproval else {
            throw BackgroundConfigurationError.registrationUnavailable
        }
    }
    static func foregroundStatus(registration: String, connected: Bool, pendingEnable: Bool) -> String {
        if registration == "requires-approval" { return "requires-approval" }
        if registration == "unavailable" { return "unavailable" }
        return connected && (pendingEnable || registration == "enabled") ? "pending-restart" : "unavailable"
    }
}

struct BackgroundBridgePolicy {
    // A launchd restart may take its full throttle interval. Reconnect only
    // the management pipe; never create a second daemon to repair that pipe.
    static func reconnectDelay(attempt: Int, wasConnected: Bool,
                               managedAvailable: Bool, intentionalStop: Bool) -> TimeInterval? {
        guard !intentionalStop, attempt < 40, !wasConnected || managedAvailable else { return nil }
        return min(2, 0.25 * pow(1.25, Double(max(0, attempt - 1))))
    }
}

// Shared by the GUI and the launchd entrypoint. Only Co²'s private preferences
// are read; neither path touches Codex authentication or conversation files.
struct BackgroundConfiguration {
    static let plistName = "local.codexco2.sharing.plist"
    static let label = "local.codexco2.sharing"
    static func hasRecoveryState(runtime: URL) -> Bool {
        // Inspect presence only, never invitation credentials or conversation
        // data. Ambiguous/unsafe entries must not authorize destructive fallback.
        var info = stat()
        return lstat(runtime.appendingPathComponent("lan-invite-recovery.json").path, &info) == 0 || errno != ENOENT
    }
    static func defaultRuntime(home: URL = FileManager.default.homeDirectoryForCurrentUser) -> URL {
        home.appendingPathComponent("Library/Application Support/Codex Co²/.coop")
    }
    static func privateJSON(_ file: URL) throws -> [String: Any]? {
        let fd = Darwin.open(file.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        if fd < 0 {
            if errno == ENOENT { return nil }
            throw BackgroundConfigurationError.invalidPrivateFile
        }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        defer { try? handle.close() }
        var info = stat()
        guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG,
              info.st_uid == geteuid(), (info.st_mode & 0o077) == 0,
              info.st_size >= 0, info.st_size <= 4096,
              let bytes = try handle.readToEnd(), bytes.count <= 4096,
              let value = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else {
            throw BackgroundConfigurationError.invalidPrivateFile
        }
        return value
    }
    static func runtime(arguments: [String] = CommandLine.arguments,
                        home: URL = FileManager.default.homeDirectoryForCurrentUser) throws -> URL {
        let fallback = defaultRuntime(home: home)
        var selected = fallback.path
        if let index = arguments.firstIndex(of: "--runtime-dir") {
            guard index + 1 < arguments.count else { throw BackgroundConfigurationError.invalidRuntime }
            selected = arguments[index + 1]
        } else if let data = try privateJSON(fallback.appendingPathComponent("app-settings.json")) {
            guard let configured = data["runtimeDirectory"] as? String else { throw BackgroundConfigurationError.invalidSettings }
            selected = configured
        }
        guard selected.hasPrefix("/"), !selected.contains("\0") else { throw BackgroundConfigurationError.invalidRuntime }
        let result = URL(fileURLWithPath: selected).standardizedFileURL
        guard result.lastPathComponent == ".coop", result.resolvingSymlinksInPath().lastPathComponent == ".coop" else {
            throw BackgroundConfigurationError.invalidRuntime
        }
        return result
    }
    static func isBoolean(_ value: Any?) -> Bool {
        guard let value = value else { return false }
        return CFGetTypeID(value as CFTypeRef) == CFBooleanGetTypeID()
    }
    static func enabled(runtime: URL) throws -> Bool {
        guard let data = try privateJSON(runtime.appendingPathComponent("background-settings.json")) else { return true }
        guard Set(data.keys) == Set(["version", "enabled"]), !isBoolean(data["version"]), data["version"] as? Int == 1,
              isBoolean(data["enabled"]), let enabled = data["enabled"] as? Bool else {
            throw BackgroundConfigurationError.invalidSettings
        }
        return enabled
    }
    static func saveRuntime(_ selected: URL, home: URL = FileManager.default.homeDirectoryForCurrentUser) throws {
        guard selected.isFileURL, selected.lastPathComponent == ".coop" else { throw BackgroundConfigurationError.invalidRuntime }
        let directory = defaultRuntime(home: home)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        var info = stat()
        guard lstat(directory.path, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR,
              info.st_uid == geteuid(), (info.st_mode & 0o077) == 0 else {
            throw BackgroundConfigurationError.invalidPrivateFile
        }
        let file = directory.appendingPathComponent("app-settings.json")
        var data = try privateJSON(file) ?? [:]
        data["runtimeDirectory"] = selected.resolvingSymlinksInPath().path
        let bytes = try JSONSerialization.data(withJSONObject: data)
        let temporary = directory.appendingPathComponent("app-settings.\(UUID().uuidString).tmp")
        let fd = Darwin.open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw BackgroundConfigurationError.invalidPrivateFile }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        defer { try? handle.close(); try? FileManager.default.removeItem(at: temporary) }
        try handle.write(contentsOf: bytes)
        guard fsync(fd) == 0, Darwin.rename(temporary.path, file.path) == 0 else {
            throw BackgroundConfigurationError.invalidPrivateFile
        }
        let directoryFD = Darwin.open(directory.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        if directoryFD >= 0 { defer { Darwin.close(directoryFD) }; guard fsync(directoryFD) == 0 else { throw BackgroundConfigurationError.invalidPrivateFile } }
    }
    static func action(_ body: Any) -> (String, Bool?)? {
        guard let data = body as? [String: Any], let action = data["action"] as? String else { return nil }
        if action == "status", Set(data.keys) == Set(["action"]) { return (action, nil) }
        if action == "settings", Set(data.keys) == Set(["action"]) { return (action, nil) }
        if action == "set", Set(data.keys) == Set(["action", "enabled"]), isBoolean(data["enabled"]),
           let enabled = data["enabled"] as? Bool { return (action, enabled) }
        return nil
    }
    static func environment(resources: URL, home: URL = FileManager.default.homeDirectoryForCurrentUser,
                            source: [String: String] = ProcessInfo.processInfo.environment) -> [String: String] {
        var clean = ["PATH": resources.appendingPathComponent("runtime").path + ":/usr/bin:/bin:/usr/sbin:/sbin",
                     "HOME": home.path, "LANG": source["LANG"] ?? "en_US.UTF-8"]
        for key in ["USER", "LOGNAME", "TMPDIR"] { if let value = source[key] { clean[key] = value } }
        return clean
    }
    static func arguments(resources: URL, runtime: URL, mode: String) -> [String] {
        let service = resources.appendingPathComponent("service")
        return [service.appendingPathComponent("bin/desktop-service.mjs").path, mode,
                "--resource-root", service.path, "--runtime-dir", runtime.path, "--attach",
                "--cloudflared", resources.appendingPathComponent("runtime/cloudflared").path]
    }
    static func runAgentIfRequested() -> Bool {
        guard CommandLine.arguments.contains("--background-service") else { return false }
        do {
            guard CommandLine.arguments.count == 2, let resources = Bundle.main.resourceURL else {
                throw BackgroundConfigurationError.unavailableBundle
            }
            let selected = try runtime(arguments: [])
            let binary = resources.appendingPathComponent("runtime/node").path
            var arguments = [binary] + self.arguments(resources: resources, runtime: selected, mode: "--daemon")
            if let official = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.openai.codex") {
                arguments.append(contentsOf: ["--desktop-app", official.path])
            }
            let argv = arguments.map { strdup($0) } + [nil]
            let env = environment(resources: resources).sorted { $0.key < $1.key }.map { strdup("\($0.key)=\($0.value)") } + [nil]
            defer { argv.forEach { free($0) }; env.forEach { free($0) } }
            // Replace the LaunchAgent executable. There is no GUI parent and no
            // inherited pipe whose EOF could end the sharing service.
            execve(binary, argv, env)
        } catch { /* The GUI reports invalid settings; no private data is logged. */ }
        // Configuration faults require a user repair, not an endless launchd loop.
        return true
    }
}

final class BackgroundRegistration {
    private let service = SMAppService.agent(plistName: BackgroundConfiguration.plistName)
    private lazy var signingStatus = BackgroundSigningPolicy.current()
    var supportsManagedLaunch: Bool { signingStatus == .identified }
    var status: String {
        switch service.status {
        case .enabled: return "enabled"
        case .requiresApproval: return "requires-approval"
        case .notRegistered: return "not-registered"
        case .notFound: return "unavailable"
        @unknown default: return "unavailable"
        }
    }
    var available: Bool {
        Bundle.main.bundleURL.pathExtension == "app"
            && FileManager.default.fileExists(atPath: Bundle.main.bundleURL.appendingPathComponent("Contents/Library/LaunchAgents/" + BackgroundConfiguration.plistName).path)
            && !Bundle.main.bundleURL.path.hasPrefix("/Volumes/")
    }
    func register() throws {
        guard available else { throw BackgroundConfigurationError.unavailableBundle }
        // A failed lookup must not silently skip registration. Attempt it so
        // the framework can report the actual bundle/signing error.
        try BackgroundRegistrationPolicy.registerIfNeeded(status: { self.service.status }, register: { try self.service.register() })
    }
    private let receipt = BackgroundRegistrationReceipt()
    func start(runtime: URL, allowManaged requested: Bool? = nil, shouldContinue: @escaping () -> Bool,
               completion: @escaping (BackgroundStartResult) -> Void) {
        receipt.clear()
        guard available else { completion(.registrationFailed); return }
        let allowManaged = requested ?? supportsManagedLaunch
        let identity: BackgroundRegistrationIdentity?, matches: Bool
        if allowManaged {
            do { identity = try BackgroundRegistrationIdentity.capture() }
            catch { completion(.unverified); return }
            // A corrupt receipt is not an authority. Treat it as unknown so a
            // live authenticated service remains usable; safe save rejects it.
            matches = (try? BackgroundRegistrationIdentity.read(runtime: runtime)) == identity
        } else { identity = nil; matches = false }
        let target = "gui/\(geteuid())/\(BackgroundConfiguration.label)"
        BackgroundPreflightPolicy.start(identityMatches: matches, allowManaged: allowManaged, registration: { self.service.status }, shouldContinue: shouldContinue,
            inspect: { reply in
                BackgroundCommand.run(arguments: ["print", target]) { result in
                    switch result {
                    case .exited(let code, let output): reply(BackgroundJobState.parse(status: code, output: output))
                    case .timedOut: reply(.unavailable(.timedOut))
                    case .launchFailed: reply(.unavailable(.launchFailed))
                    case .unverified: reply(.unavailable(.unverified))
                    }
                }
            }, bootout: { reply in
                BackgroundLaunchPolicy.runKickstart(arguments: ["bootout", target], completion: reply)
            }, unregister: { reply in
                if self.service.status == .notRegistered || self.service.status == .notFound { reply(true); return }
                self.service.unregister { error in DispatchQueue.main.async { reply(error == nil) } }
            }, register: { try self.service.register() },
            settle: { interval, action in DispatchQueue.main.asyncAfter(deadline: .now() + interval, execute: action) },
            registered: { if let identity = identity { self.receipt.stage(runtime: runtime, identity: identity) } },
            kickstart: { reply in BackgroundLaunchPolicy.runKickstart(arguments: ["kickstart", target], completion: reply) },
            completion: { result in
                if result != .started { self.receipt.clear() }
                completion(result)
            })
    }
    func confirmReady(runtime: URL) throws {
        // Replacing the bundle while this manager was starting must not bless
        // registration of different code. The record is not an authorization.
        try receipt.confirmReady(runtime: runtime) { try BackgroundRegistrationIdentity.capture() }
    }
    func unregister(_ completion: @escaping (Bool) -> Void) {
        if service.status == .notRegistered || service.status == .notFound { completion(true); return }
        service.unregister { error in DispatchQueue.main.async { completion(error == nil) } }
    }
    func openSettings() { SMAppService.openSystemSettingsLoginItems() }
}
