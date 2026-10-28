import AppKit
import ServiceManagement
import CoreFoundation

enum BackgroundConfigurationError: Error {
    case invalidPrivateFile
    case invalidSettings
    case invalidRuntime
    case unavailableBundle
    case registrationUnavailable
}

enum BackgroundStartResult: Equatable {
    case started
    case missing
    case cancelled
    case failed(Int32)
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
        let task = Process(); task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        task.arguments = arguments
        task.standardInput = FileHandle.nullDevice; task.standardOutput = FileHandle.nullDevice; task.standardError = FileHandle.nullDevice
        var finished = false
        func finish(_ result: BackgroundStartResult) {
            guard !finished else { return }; finished = true; completion(result)
        }
        task.terminationHandler = { process in DispatchQueue.main.async {
            guard process.terminationReason == .exit else { finish(.failed(process.terminationStatus)); return }
            switch process.terminationStatus {
            case 0: finish(.started)
            case 113: finish(.missing) // launchctl: service not found in this domain
            default: finish(.failed(process.terminationStatus))
            }
        } }
        do { try task.run() } catch { finish(.failed(-1)); return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
            guard !finished else { return }
            finish(.failed(-1)); if task.isRunning { task.terminate() }
        }
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
    func start(shouldContinue: @escaping () -> Bool, completion: @escaping (BackgroundStartResult) -> Void) {
        guard service.status == .enabled else { completion(.missing); return }
        BackgroundLaunchPolicy.start(shouldContinue: shouldContinue, kickstart: { reply in
            BackgroundLaunchPolicy.runKickstart(arguments: ["kickstart", "gui/\(geteuid())/\(BackgroundConfiguration.label)"], completion: reply)
        }, repair: { reply in
            self.service.unregister { error in DispatchQueue.main.async {
                guard error == nil, shouldContinue() else { reply(false); return }
                do {
                    // Unregistration has completed. Do not let a stale status
                    // lookup skip the actual registration operation again.
                    try self.service.register()
                    reply(self.service.status == .enabled)
                } catch { reply(false) }
            } }
        }, completion: completion)
    }
    func unregister(_ completion: @escaping (Bool) -> Void) {
        if service.status == .notRegistered || service.status == .notFound { completion(true); return }
        service.unregister { error in DispatchQueue.main.async { completion(error == nil) } }
    }
    func openSettings() { SMAppService.openSystemSettingsLoginItems() }
}
