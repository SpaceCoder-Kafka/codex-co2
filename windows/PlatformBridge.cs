using System.ComponentModel;
using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

namespace CodexCo2;

// A narrow native boundary for the packaged Node service. It never reads an
// authentication file, conversation body, settings, or the real SQLite index.
// Security checks inspect Windows metadata only. No alternate Codex runtime is
// started when the existing official Desktop interface is unavailable.
internal static class PlatformBridge
{
    private const string DesktopPipe = @"\\.\pipe\codex-ipc";
    private const uint OwnerSecurity = 0x1, DaclSecurity = 0x4;
    private const uint ProtectedDaclSecurity = 0x80000000;
    private const uint ReadControl = 0x20000, TokenQuery = 0x8;
    // Identify-only SQOS is set at open time, before the server is verified.
    // A hostile process occupying the fixed name must not impersonate this
    // client (especially an elevated manager) during the authentication check.
    private const uint PipeClientFlags = 0x40000000 | 0x00100000 | 0x00010000;
    private static string CurrentSid => WindowsIdentity.GetCurrent().User?.Value
        ?? throw new InvalidOperationException("Windows user SID unavailable");

    internal static int? Run(string[] args)
    {
        if (args.Length == 0 || args[0] != "--co2-platform") return null;
        try
        {
            if (!OperatingSystem.IsWindowsVersionAtLeast(10)) throw new InvalidOperationException("Windows 10 is required");
            if (args.Length < 2) throw new ArgumentException("Missing platform command");
            switch (args[1])
            {
                case "desktop-ipc" when args.Length == 2:
                    RunDesktopPipe(); return 0;
                case "check-path" when args.Length == 4:
                    CheckPath(args[2], args[3]); WriteJson(new { ok = true }); return 0;
                case "secure-directory" when args.Length == 3:
                    SecureDirectory(args[2]); WriteJson(new { ok = true }); return 0;
                case "process-identity" when args.Length == 3:
                    if (!int.TryParse(args[2], out int pid) || pid <= 1) throw new ArgumentException("Invalid PID");
                    WriteJson(new { ok = true, identity = ProcessIdentity(pid) }); return 0;
                case "security-self-test" when args.Length == 2:
                    SecuritySelfTest(); return 0;
                case "write-private-file" when args.Length == 3:
                    WritePrivateFile(args[2], ReadPrivateInput()); WriteJson(new { ok = true }); return 0;
                default: throw new ArgumentException("Unsupported platform command");
            }
        }
        catch
        {
            // Do not leak private filenames, process paths, SID values or
            // protocol bytes into the parent service's logs or the web UI.
            if (args.Length > 1 && args[1] != "desktop-ipc") WriteJson(new { ok = false });
            return 1;
        }
    }

    private static void WriteJson(object value) => Console.Out.WriteLine(JsonSerializer.Serialize(value));

    private static void RejectReparsePoints(string input)
    {
        if (!Path.IsPathFullyQualified(input)) throw new ArgumentException("Absolute path required");
        string fullPath = Path.GetFullPath(input);
        if (fullPath.StartsWith(@"\\", StringComparison.Ordinal)) throw new ArgumentException("Local drive paths required");
        string? cursor = fullPath;
        while (!string.IsNullOrEmpty(cursor))
        {
            try
            {
                if ((File.GetAttributes(cursor) & FileAttributes.ReparsePoint) != 0)
                    throw new InvalidOperationException("Reparse points are not allowed");
            }
            catch (FileNotFoundException) { }
            catch (DirectoryNotFoundException) { }
            cursor = Path.GetDirectoryName(cursor);
        }
    }

    private static void CheckPath(string path, string kind)
    {
        RejectReparsePoints(path);
        var attributes = File.GetAttributes(path);
        bool directory = (attributes & FileAttributes.Directory) != 0;
        if (kind != "private-file" && kind != "private-directory") throw new ArgumentException("Invalid path check");
        if ((kind == "private-directory") != directory) throw new InvalidOperationException("Unexpected path type");
        uint error = GetNamedSecurityInfo(path, 1, OwnerSecurity | DaclSecurity,
            out _, out _, out _, out _, out var descriptor);
        if (error != 0) throw new Win32Exception((int)error);
        try { CheckDescriptor(descriptor, CurrentSid); }
        finally { LocalFree(descriptor); }
    }

    private static void CheckDescriptor(IntPtr descriptor, string owner)
    {
        uint size = GetSecurityDescriptorLength(descriptor);
        if (size == 0 || size > 1024 * 1024) throw new InvalidOperationException("Invalid security descriptor");
        var bytes = new byte[size]; Marshal.Copy(descriptor, bytes, 0, bytes.Length);
        var security = new RawSecurityDescriptor(bytes, 0);
        if (security.Owner?.Value != owner || security.DiscretionaryAcl == null ||
            !security.ControlFlags.HasFlag(ControlFlags.DiscretionaryAclPresent))
            throw new InvalidOperationException("Local object is not privately owned");
        var allowed = new HashSet<string>(StringComparer.Ordinal)
            { owner, "S-1-5-18", "S-1-5-32-544" };
        foreach (GenericAce ace in security.DiscretionaryAcl)
        {
            if (ace is not QualifiedAce qualified) throw new InvalidOperationException("Unsupported local ACL");
            if (qualified.AceQualifier == AceQualifier.AccessDenied) continue;
            if (qualified.AceQualifier != AceQualifier.AccessAllowed || qualified.IsCallback ||
                (qualified.AccessMask != 0 && !allowed.Contains(qualified.SecurityIdentifier.Value)))
                throw new InvalidOperationException("Local object permits another user");
        }
    }

    internal static void SecureDirectory(string path)
    {
        RejectReparsePoints(path);
        CreatePrivateDirectories(path);
        RejectReparsePoints(path);
        // Existing directories are never taken over, including directories
        // owned by the Administrators group under an elevated token.
        uint ownerError = GetNamedSecurityInfo(path, 1, OwnerSecurity, out var owner, out _, out _, out _, out var oldDescriptor);
        if (ownerError != 0) throw new Win32Exception((int)ownerError);
        try { if (new SecurityIdentifier(owner).Value != CurrentSid) throw new InvalidOperationException("Unexpected directory owner"); }
        finally { LocalFree(oldDescriptor); }
        // Protected DACL; all new runtime files inherit only this user and
        // SYSTEM. Administrators can still exercise normal OS ownership rights.
        var descriptor = new RawSecurityDescriptor($"O:{CurrentSid}D:P(A;OICI;FA;;;{CurrentSid})(A;OICI;FA;;;SY)");
        var dacl = descriptor.DiscretionaryAcl ?? throw new InvalidOperationException("Missing DACL");
        var acl = new byte[dacl.BinaryLength]; dacl.GetBinaryForm(acl, 0);
        var pinned = GCHandle.Alloc(acl, GCHandleType.Pinned);
        try
        {
            uint error = SetNamedSecurityInfo(path, 1, DaclSecurity | ProtectedDaclSecurity,
                IntPtr.Zero, IntPtr.Zero, pinned.AddrOfPinnedObject(), IntPtr.Zero);
            if (error != 0) throw new Win32Exception((int)error);
        }
        finally { pinned.Free(); }
        CheckPath(path, "private-directory");
    }

    private static void CreatePrivateDirectories(string path)
    {
        RejectReparsePoints(path);
        if (Directory.Exists(path)) return;
        string parent = Path.GetDirectoryName(path) ?? throw new ArgumentException("Cannot create drive root");
        if (!Directory.Exists(parent)) CreatePrivateDirectories(parent);
        RejectReparsePoints(path);
        // A null creation security descriptor inherits the elevated token's
        // default owner (often Administrators). Supply owner + protected ACL
        // atomically, before any runtime file can be written into the folder.
        var descriptor = new RawSecurityDescriptor($"O:{CurrentSid}D:P(A;OICI;FA;;;{CurrentSid})(A;OICI;FA;;;SY)");
        var bytes = new byte[descriptor.BinaryLength]; descriptor.GetBinaryForm(bytes, 0);
        var pinned = GCHandle.Alloc(bytes, GCHandleType.Pinned);
        try
        {
            var attributes = new SecurityAttributes { Length = Marshal.SizeOf<SecurityAttributes>(), Descriptor = pinned.AddrOfPinnedObject() };
            if (!CreateDirectory(path, ref attributes))
            {
                int error = Marshal.GetLastWin32Error();
                if (error != 183) throw new Win32Exception(error); // ERROR_ALREADY_EXISTS
                // A concurrent creator is checked without changing its owner.
                CheckPath(path, "private-directory");
            }
        }
        finally { pinned.Free(); }
    }

    private static string ProcessIdentity(int pid)
    {
        using var process = OpenProcess(0x1000, false, (uint)pid);
        if (process.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
        if (ProcessSid(process) != CurrentSid) throw new InvalidOperationException("Different process user");
        if (!GetProcessTimes(process, out var created, out _, out _, out _)) throw new Win32Exception(Marshal.GetLastWin32Error());
        var name = new System.Text.StringBuilder(32768); uint length = (uint)name.Capacity;
        if (!QueryFullProcessImageName(process, 0, name, ref length)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return $"{pid}:{created}:{name}";
    }

    private static byte[] ReadPrivateInput()
    {
        using var input = Console.OpenStandardInput(); using var output = new MemoryStream();
        var buffer = new byte[65536]; int count;
        while ((count = input.Read(buffer, 0, buffer.Length)) > 0)
        {
            if (output.Length + count > 32 * 1024 * 1024) throw new InvalidOperationException("Private input is too large");
            output.Write(buffer, 0, count);
        }
        return output.ToArray();
    }

    internal static void WritePrivateFile(string path, byte[] contents)
    {
        if (contents.Length > 32 * 1024 * 1024) throw new InvalidOperationException("Private input is too large");
        RejectReparsePoints(path);
        CheckPath(Path.GetDirectoryName(path) ?? throw new ArgumentException("Missing private directory"), "private-directory");
        var descriptor = new RawSecurityDescriptor($"O:{CurrentSid}D:P(A;;FA;;;{CurrentSid})(A;;FA;;;SY)");
        var bytes = new byte[descriptor.BinaryLength]; descriptor.GetBinaryForm(bytes, 0);
        var pinned = GCHandle.Alloc(bytes, GCHandleType.Pinned);
        try
        {
            var attributes = new SecurityAttributes { Length = Marshal.SizeOf<SecurityAttributes>(), Descriptor = pinned.AddrOfPinnedObject() };
            using var handle = CreatePrivateFile(path, 0x40000000, 0, ref attributes, 1, 0x80, IntPtr.Zero);
            if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
            using var stream = new FileStream(handle, FileAccess.Write);
            stream.Write(contents); stream.Flush(true);
        }
        finally { pinned.Free(); }
    }

    private static string ProcessSid(SafeProcessHandle process)
    {
        if (!OpenProcessToken(process, TokenQuery, out var token)) throw new Win32Exception(Marshal.GetLastWin32Error());
        using (token)
        {
            GetTokenInformation(token, 1, IntPtr.Zero, 0, out uint size);
            if (size == 0 || size > 65536) throw new InvalidOperationException("Invalid process token");
            IntPtr data = Marshal.AllocHGlobal((int)size);
            try
            {
                if (!GetTokenInformation(token, 1, data, size, out _)) throw new Win32Exception(Marshal.GetLastWin32Error());
                return new SecurityIdentifier(Marshal.ReadIntPtr(data)).Value;
            }
            finally { Marshal.FreeHGlobal(data); }
        }
    }

    private static void RunDesktopPipe()
    {
        // Open precisely the official endpoint established from the Desktop's
        // bundled platform code. No caller-selected pipe or alternate backend.
        SafePipeHandle? handle = null;
        long deadline = Environment.TickCount64 + 10000;
        while (Environment.TickCount64 < deadline)
        {
            handle = CreateFile(DesktopPipe, 0xC0000000 | ReadControl, 0, IntPtr.Zero, 3, PipeClientFlags, IntPtr.Zero);
            if (!handle.IsInvalid) break;
            int error = Marshal.GetLastWin32Error(); handle.Dispose(); handle = null;
            if (error != 231 && error != 2) throw new Win32Exception(error);
            Thread.Sleep(100);
        }
        if (handle == null || handle.IsInvalid) throw new InvalidOperationException("Official Desktop pipe unavailable");
        using (handle)
        {
            VerifyConnectedPipe(handle);
            using var pipe = new NamedPipeClientStream(PipeDirection.InOut, true, true, handle);
            using var input = Console.OpenStandardInput(); using var output = Console.OpenStandardOutput();
            Console.Error.Write("CO2_IPC_READY\n"); Console.Error.Flush();
            using var cancel = new CancellationTokenSource();
            var upload = input.CopyToAsync(pipe, cancel.Token);
            var download = pipe.CopyToAsync(output, cancel.Token);
            Task.WhenAny(upload, download).GetAwaiter().GetResult();
            cancel.Cancel();
            // Closing this client handle affects neither Desktop nor other
            // clients. Parent-stdin EOF ends the proxy and its attachment.
        }
    }

    private static void VerifyConnectedPipe(SafePipeHandle handle)
    {
        if (!GetNamedPipeServerProcessId(handle, out uint pid) || pid <= 1) throw new Win32Exception(Marshal.GetLastWin32Error());
        using var server = OpenProcess(0x1000, false, pid);
        if (server.IsInvalid || ProcessSid(server) != CurrentSid) throw new InvalidOperationException("Desktop is not running as this Windows user");
        uint error = GetSecurityInfo(handle.DangerousGetHandle(), 1, OwnerSecurity | DaclSecurity,
            out _, out _, out _, out _, out var descriptor);
        if (error != 0) throw new Win32Exception((int)error);
        try { CheckDescriptor(descriptor, CurrentSid); }
        finally { LocalFree(descriptor); }
    }

    // CI exercises the actual OS ACL/token/pipe code using disposable synthetic
    // objects only. This command never opens the official pipe or user index.
    private static void SecuritySelfTest()
    {
        string root = Path.Combine(Path.GetTempPath(), "co2-native-security-" + Guid.NewGuid().ToString("N"));
        try
        {
            SecureDirectory(root);
            string file = Path.Combine(root, "synthetic.txt"); WritePrivateFile(file, System.Text.Encoding.UTF8.GetBytes("synthetic fixture"));
            CheckPath(file, "private-file");
            var broad = new RawSecurityDescriptor($"O:{CurrentSid}D:P(A;;FA;;;{CurrentSid})(A;;FR;;;WD)");
            var acl = new byte[broad.DiscretionaryAcl!.BinaryLength]; broad.DiscretionaryAcl.GetBinaryForm(acl, 0);
            var pinned = GCHandle.Alloc(acl, GCHandleType.Pinned);
            try
            {
                uint error = SetNamedSecurityInfo(file, 1, DaclSecurity | ProtectedDaclSecurity,
                    IntPtr.Zero, IntPtr.Zero, pinned.AddrOfPinnedObject(), IntPtr.Zero);
                if (error != 0) throw new Win32Exception((int)error);
            }
            finally { pinned.Free(); }
            bool broadRejected = false;
            try { CheckPath(file, "private-file"); } catch { broadRejected = true; }
            if (!broadRejected) throw new InvalidOperationException("Broad ACL accepted");

            string pipeName = "co2-synthetic-" + Guid.NewGuid().ToString("N");
            // Windows' default pipe DACL can grant broad read access. Our
            // synthetic accepted endpoint explicitly has the same private ACL
            // that production verification requires; do not weaken that check
            // to make a permissive default endpoint pass.
            var pipeSecurity = new RawSecurityDescriptor($"O:{CurrentSid}D:P(A;;FA;;;{CurrentSid})(A;;FA;;;SY)");
            var pipeDescriptor = new byte[pipeSecurity.BinaryLength]; pipeSecurity.GetBinaryForm(pipeDescriptor, 0);
            var pipePinned = GCHandle.Alloc(pipeDescriptor, GCHandleType.Pinned);
            SafePipeHandle serverHandle;
            try
            {
                var attributes = new SecurityAttributes { Length = Marshal.SizeOf<SecurityAttributes>(), Descriptor = pipePinned.AddrOfPinnedObject() };
                // Duplex already grants DACL-read access. READ_CONTROL is not
                // a valid CreateNamedPipe open-mode flag (unlike CreateFile).
                serverHandle = CreateNamedPipe(@"\\.\pipe\" + pipeName, 0x40080003, 0, 1, 4096, 4096, 0, ref attributes);
                if (serverHandle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            finally { pipePinned.Free(); }
            using var server = new NamedPipeServerStream(PipeDirection.InOut, true, false, serverHandle);
            var waiting = server.WaitForConnectionAsync();
            using var clientHandle = CreateFile(@"\\.\pipe\" + pipeName, 0xC0000000 | ReadControl,
                0, IntPtr.Zero, 3, PipeClientFlags, IntPtr.Zero);
            if (clientHandle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
            VerifyConnectedPipe(clientHandle);
            using var client = new NamedPipeClientStream(PipeDirection.InOut, true, true, clientHandle);
            waiting.WaitAsync(TimeSpan.FromSeconds(5)).GetAwaiter().GetResult();
            byte[] frame = { 4, 0, 0, 0, 123, 125, 10, 0 };
            client.Write(frame); client.Flush();
            var received = new byte[frame.Length]; server.ReadExactly(received);
            if (!received.SequenceEqual(frame)) throw new InvalidOperationException("Pipe payload changed");
            WriteJson(new { ok = true, privateAcl = true, broadAclRejected = true,
                connectedServerUserVerified = true, binaryPipeRoundtrip = true });
        }
        finally { if (Directory.Exists(root)) Directory.Delete(root, true); }
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetNamedSecurityInfoW")]
    private static extern uint GetNamedSecurityInfo(string name, int type, uint info, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, EntryPoint = "SetNamedSecurityInfoW")]
    private static extern uint SetNamedSecurityInfo(string name, int type, uint info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
    [DllImport("advapi32.dll")]
    private static extern uint GetSecurityInfo(IntPtr handle, int type, uint info, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll")]
    private static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateFileW")]
    private static extern SafePipeHandle CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateFileW")]
    private static extern SafeFileHandle CreatePrivateFile(string name, uint access, uint share, ref SecurityAttributes security, uint creation, uint flags, IntPtr template);
    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes { internal int Length; internal IntPtr Descriptor; internal int InheritHandle; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateDirectoryW")]
    private static extern bool CreateDirectory(string path, ref SecurityAttributes security);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateNamedPipeW")]
    private static extern SafePipeHandle CreateNamedPipe(string name, uint openMode, uint pipeMode, uint maximum, uint outputSize, uint inputSize, uint timeout, ref SecurityAttributes security);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeProcessHandle OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(SafeProcessHandle process, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "QueryFullProcessImageNameW")]
    private static extern bool QueryFullProcessImageName(SafeProcessHandle process, uint flags, System.Text.StringBuilder name, ref uint length);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(SafeProcessHandle process, uint access, out SafeAccessTokenHandle token);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(SafeAccessTokenHandle token, int type, IntPtr data, uint length, out uint required);
}
