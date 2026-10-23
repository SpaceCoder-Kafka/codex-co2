using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace CodexCo2;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        var platform = PlatformBridge.Run(args);
        if (platform.HasValue) return platform.Value;
        ApplicationConfiguration.Initialize();
        if (!OperatingSystem.IsWindowsVersionAtLeast(10, 0, 17763))
        {
            MessageBox.Show("Codex Co² requires Windows 10 version 1809 (build 17763) or later.", "Codex Co²");
            return 1;
        }
        using var instance = new Mutex(true, "Local\\CodexCo2.Manager", out var first);
        if (!first) { MessageBox.Show("Codex Co² is already running. Open it from the notification area.", "Codex Co²"); return 0; }
        try { Application.Run(new ManagerWindow()); return 0; }
        catch { MessageBox.Show("Codex Co² could not start. Reinstall the complete preview package and check your private data folder permissions.", "Codex Co²"); return 1; }
    }
}

internal sealed class ManagerWindow : Form
{
    private readonly WebView2 view = new() { Dock = DockStyle.Fill };
    private readonly Label status = new() { Dock = DockStyle.Bottom, Height = 25, TextAlign = ContentAlignment.MiddleLeft, Padding = new Padding(14, 0, 0, 0) };
    private readonly NotifyIcon tray;
    private readonly JobScope job = new();
    private readonly string resources = Path.Combine(AppContext.BaseDirectory, "resources");
    private readonly string runtime;
    private readonly string webSession;
    private readonly Dictionary<string, string> announced = new();
    private readonly JsonElement manifest;
    private Process? helper;
    private Uri? owner;
    private Uri? manager;
    private int commandId;
    private int rooms;
    private bool quitting;
    private string language = "zh-CN";
    private string? notificationAttention;

    public ManagerWindow()
    {
        runtime = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Codex Co2", ".coop");
        PlatformBridge.SecureDirectory(runtime);
        webSession = Path.Combine(runtime, "webview-session-" + Guid.NewGuid().ToString("N"));
        PlatformBridge.SecureDirectory(webSession);
        using (var doc = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(resources, "manifest.json")))) manifest = doc.RootElement.Clone();
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(runtime, "windows-settings.json")));
            var saved = doc.RootElement.GetProperty("language").GetString();
            if (saved is "zh-CN" or "zh-TW" or "en") language = saved;
        }
        catch { /* A missing preference is normal; never inspect Desktop settings. */ }
        Text = "Codex Co²"; Size = new Size(1200, 820); MinimumSize = new Size(900, 640); StartPosition = FormStartPosition.CenterScreen;
        Icon = Icon.ExtractAssociatedIcon(Environment.ProcessPath!) ?? SystemIcons.Application;
        Controls.Add(view); Controls.Add(status);
        var menu = new MenuStrip();
        var appMenu = new ToolStripMenuItem("Codex Co²");
        appMenu.DropDownItems.Add("About / 关于", null, async (_, _) => await Script("window.showCo2About?.()"));
        appMenu.DropDownItems.Add("Settings / 设置", null, async (_, _) => await Script("window.showCo2Settings?.()"));
        appMenu.DropDownItems.Add("Download updates / 下载更新", null, (_, _) => OpenProject("releases"));
        appMenu.DropDownItems.Add(new ToolStripSeparator());
        appMenu.DropDownItems.Add("Quit / 退出", null, async (_, _) => await QuitAsync());
        menu.Items.Add(appMenu); MainMenuStrip = menu; Controls.Add(menu);
        var context = new ContextMenuStrip();
        context.Items.Add("Show manager / 显示管理窗口", null, (_, _) => ShowManager());
        context.Items.Add("Connect current Codex / 连接当前 Codex", null, async (_, _) => { if (helper is null || helper.HasExited) StartHelper(); else await Send("connect-current"); });
        context.Items.Add("Open Codex / 打开 Codex", null, (_, _) => OpenCodex());
        context.Items.Add("Stop all sharing / 停止全部共享", null, async (_, _) => await Send("revoke-all"));
        context.Items.Add(new ToolStripSeparator());
        context.Items.Add("Quit / 退出", null, async (_, _) => await QuitAsync());
        tray = new NotifyIcon { Icon = Icon, Text = "Codex Co²", Visible = true, ContextMenuStrip = context };
        tray.DoubleClick += (_, _) => ShowManager();
        tray.BalloonTipClicked += async (_, _) => { ShowManager(); if (notificationAttention is not null) await Script("window.openCo2Attention?.(" + JsonSerializer.Serialize(notificationAttention) + ")"); };
        FormClosing += (_, e) => { if (!quitting && e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; Hide(); } };
        FormClosed += (_, _) => Cleanup();
        Shown += async (_, _) => await InitializeAsync();
        status.Text = "正在启动本地管理…";
    }

    private async Task InitializeAsync()
    {
        try
        {
            var environment = await CoreWebView2Environment.CreateAsync(null, webSession);
            await view.EnsureCoreWebView2Async(environment);
            var browser = view.CoreWebView2;
            browser.Settings.AreDevToolsEnabled = false;
            browser.Settings.AreDefaultContextMenusEnabled = false;
            browser.Settings.IsStatusBarEnabled = false;
            browser.Settings.IsPasswordAutosaveEnabled = false;
            browser.Settings.IsGeneralAutofillEnabled = false;
            browser.Settings.IsBuiltInErrorPageEnabled = false;
            browser.NavigationStarting += (_, e) => { if (!Policy.SameOrigin(owner, e.Uri)) e.Cancel = true; };
            browser.FrameNavigationStarting += (_, e) => e.Cancel = true;
            browser.NewWindowRequested += (_, e) => { e.Handled = true; };
            browser.DownloadStarting += (_, e) => e.Cancel = true;
            browser.PermissionRequested += (_, e) => e.State = CoreWebView2PermissionState.Deny;
            browser.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
            browser.WebResourceRequested += (_, e) =>
            {
                if (!Policy.SameOrigin(owner, e.Request.Uri))
                    e.Response = environment.CreateWebResourceResponse(new MemoryStream(), 403, "Blocked", "Content-Type: text/plain");
            };
            browser.WebMessageReceived += async (_, e) => await ReceiveWebMessage(e);
            browser.NavigationCompleted += async (_, _) => await Script("window.setCo2SuggestedName?.(" + JsonSerializer.Serialize(Environment.UserName) + ")");
            StartHelper();
        }
        catch (WebView2RuntimeNotFoundException)
        {
            status.Text = "需要 Microsoft Edge WebView2 Runtime。安装后重新打开 Co²。";
            if (MessageBox.Show("Install Microsoft Edge WebView2 Runtime from Microsoft's official website, then reopen Codex Co²?", "WebView2 Runtime required", MessageBoxButtons.OKCancel) == DialogResult.OK)
                Process.Start(new ProcessStartInfo("https://developer.microsoft.com/en-us/microsoft-edge/webview2/") { UseShellExecute = true });
        }
        catch { status.Text = "无法初始化管理窗口。请重新安装完整应用包。"; }
    }

    private void StartHelper()
    {
        if (quitting || helper is { HasExited: false }) return;
        owner = null; rooms = 0; announced.Clear();
        var binaries = Path.Combine(resources, "runtime");
        var service = Path.Combine(resources, "service");
        var start = new ProcessStartInfo(Path.Combine(binaries, "node.exe"))
        {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            StandardInputEncoding = new UTF8Encoding(false), StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8, WorkingDirectory = resources
        };
        foreach (var argument in new[] { Path.Combine(service, "bin", "desktop-service.mjs"), "--resource-root", service, "--runtime-dir", runtime, "--attach", "--parent-ready", "--cloudflared", Path.Combine(binaries, "cloudflared.exe") }) start.ArgumentList.Add(argument);
        var inherited = new Dictionary<string, string?>();
        foreach (var name in new[] { "USERPROFILE", "LOCALAPPDATA", "APPDATA", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "COMSPEC", "USERNAME", "HOMEDRIVE", "HOMEPATH" }) inherited[name] = Environment.GetEnvironmentVariable(name);
        start.Environment.Clear();
        foreach (var item in inherited) if (!string.IsNullOrEmpty(item.Value)) start.Environment[item.Key] = item.Value;
        start.Environment["PATH"] = binaries + ";" + Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "System32");
        start.Environment["CO2_PLATFORM_BRIDGE"] = Environment.ProcessPath!;
        try
        {
            var process = Process.Start(start) ?? throw new IOException("Could not start bundled helper");
            helper = process; job.Assign(process);
            // The service performs no runtime work or child creation until
            // containment succeeds and this exact private handshake arrives.
            process.StandardInput.Write("CO2_PARENT_READY\n"); process.StandardInput.Flush();
            process.ErrorDataReceived += (_, _) => { }; process.BeginErrorReadLine();
            _ = ReadHelperAsync(process);
            status.Text = "正在连接已运行的官方 Codex…";
        }
        catch { helper = null; status.Text = "无法启动内置助手。请重新安装完整应用包。"; }
    }

    private async Task ReadHelperAsync(Process process)
    {
        try
        {
            var pending = new StringBuilder(); var chunk = new char[4096];
            // Keep draining during graceful shutdown. A queued status message
            // must not cause an early kill before the helper revokes shares.
            while (helper == process)
            {
                var count = await process.StandardOutput.ReadAsync(chunk.AsMemory());
                if (count == 0) break;
                pending.Append(chunk, 0, count);
                if (pending.Length > 131072) throw new IOException("Invalid helper response size");
                int end;
                while ((end = pending.ToString().IndexOf('\n')) >= 0)
                {
                    var line = pending.ToString(0, end); pending.Remove(0, end + 1);
                    using var doc = JsonDocument.Parse(line);
                    await ReceiveHelper(doc.RootElement);
                }
            }
        }
        catch { if (!quitting) status.Text = "助手连接已停止。请从通知区域重新连接。"; }
        finally
        {
            if (helper == process)
            {
                owner = null; announced.Clear();
                try { if (!process.HasExited) process.Kill(true); } catch { }
                helper = null;
                if (!quitting) status.Text = "助手已停止，可从通知区域重新连接。";
            }
            process.Dispose();
        }
    }

    private async Task ReceiveHelper(JsonElement message)
    {
        if (!message.TryGetProperty("type", out var type)) return;
        switch (type.GetString())
        {
            case "resource":
                // Opening Desktop is brokered by this parent, outside the
                // helper's kill-on-close job. Only fixed native URI shapes
                // are accepted; the helper cannot supply an arbitrary URL.
                if (message.TryGetProperty("kind", out var kind))
                {
                    if (kind.GetString() == "desktop-open") OpenCodex();
                    else if (kind.GetString() == "desktop-thread" && message.TryGetProperty("threadId", out var thread)
                        && Guid.TryParseExact(thread.GetString(), "D", out var id)) OpenCodex(id);
                }
                break;
            case "ready":
                if (Policy.ManagerUrl(message.GetProperty("ownerUrl").GetString(), out var url))
                {
                    owner = manager = url;
                    await InstallBridge();
                    view.CoreWebView2.Navigate(url!.AbsoluteUri);
                    await Send("account");
                }
                break;
            case "status":
                rooms = message.TryGetProperty("rooms", out var count) && count.TryGetInt32(out var n) ? n : 0;
                status.Text = "本地管理就绪 · " + rooms + " 条共享";
                tray.Text = rooms > 0 ? "Codex Co² · " + rooms + " shares" : "Codex Co²";
                if (message.TryGetProperty("attention", out var items) && items.ValueKind == JsonValueKind.Array)
                {
                    var current = new HashSet<string>();
                    foreach (var item in items.EnumerateArray())
                    {
                        if (!item.TryGetProperty("id", out var key) || key.ValueKind != JsonValueKind.String
                            || !item.TryGetProperty("members", out var members) || members.ValueKind != JsonValueKind.Array) continue;
                        var id = key.GetString()!; if (id.Length > 200) continue;
                        current.Add(id); var fingerprint = members.GetRawText();
                        if (!announced.TryGetValue(id, out var before) || before != fingerprint)
                        {
                            announced[id] = fingerprint; notificationAttention = id;
                            tray.ShowBalloonTip(5000, "Codex Co²", "共享会话有事项待处理。工具审批仍需在官方 Codex 中处理。", ToolTipIcon.Info);
                        }
                    }
                    foreach (var gone in announced.Keys.Where(id => !current.Contains(id)).ToArray()) announced.Remove(gone);
                }
                break;
            case "error":
                status.Text = message.TryGetProperty("message", out var error) ? error.GetString() : "操作未完成，请检查 Codex 和网络。";
                break;
        }
    }

    private object AppInfo() => new { name = "Codex Co²", version = manifest.GetProperty("version").GetString(), build = manifest.GetProperty("build").GetString(), channel = manifest.GetProperty("channel").GetString(), canUpdate = false, starDismissed = false };
    private async Task InstallBridge()
    {
        var origin = manager!.GetLeftPart(UriPartial.Authority);
        var script = "(() => { if (window !== window.top || location.origin !== " + JsonSerializer.Serialize(origin) + ") return; "
            + "const post=(channel,body)=>window.chrome.webview.postMessage({channel,body}); "
            + "window.webkit={messageHandlers:{copyInvite:{postMessage:body=>post('copyInvite',body)},languagePreference:{postMessage:body=>post('languagePreference',body)},appUpdates:{postMessage:body=>post('appUpdates',body)}}}; "
            + "window.co2Language=" + JsonSerializer.Serialize(language) + ";window.co2AppInfo=" + JsonSerializer.Serialize(AppInfo()) + ";"
            + "window.co2UpdateState={phase:'idle',message:'Windows 预览版请从 GitHub Releases 下载更新。'}; })();";
        await view.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(script);
    }
    private async Task ReceiveWebMessage(CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (!Policy.SameOrigin(manager, e.Source) || !Policy.SameOrigin(manager, view.Source?.AbsoluteUri)) return;
        try
        {
            if (e.WebMessageAsJson.Length > 8192) return;
            using var doc = JsonDocument.Parse(e.WebMessageAsJson); var request = doc.RootElement;
            if (request.ValueKind != JsonValueKind.Object || request.EnumerateObject().Count() != 2
                || !request.TryGetProperty("channel", out var channel) || !request.TryGetProperty("body", out var body)) return;
            if (channel.GetString() == "copyInvite" && Policy.SameOrigin(owner, e.Source))
            {
                var ok = Policy.CopyRequest(body, out var id, out var link);
                if (ok) { try { Clipboard.SetText(link); } catch { ok = false; } }
                if (id.Length > 0 && id.Length <= 64)
                    await Script("window.co2InviteCopyResult?.(" + JsonSerializer.Serialize(new { requestId = id, ok }) + ")");
            }
            else if (channel.GetString() == "languagePreference" && body.ValueKind == JsonValueKind.String && body.GetString() is "zh-CN" or "zh-TW" or "en")
            {
                language = body.GetString()!;
                var temporary = Path.Combine(runtime, "windows-settings-" + Guid.NewGuid().ToString("N") + ".tmp");
                try
                {
                    PlatformBridge.WritePrivateFile(temporary, Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { language })));
                    File.Move(temporary, Path.Combine(runtime, "windows-settings.json"), true);
                }
                finally { try { File.Delete(temporary); } catch { } }
            }
            else if (channel.GetString() == "appUpdates" && body.ValueKind == JsonValueKind.Object && body.TryGetProperty("action", out var action))
            {
                if (action.GetString() == "info") await Script("window.receiveCo2AppInfo?.(" + JsonSerializer.Serialize(AppInfo()) + ")");
                else if (action.GetString() == "openLink" && body.TryGetProperty("link", out var target)) OpenProject(target.GetString());
            }
        }
        catch { /* Untrusted/malformed bridge payloads have no native effect. */ }
    }
    private async Task Script(string code)
    {
        if (view.CoreWebView2 is not null && Policy.SameOrigin(manager, view.Source?.AbsoluteUri))
            try { await view.CoreWebView2.ExecuteScriptAsync(code); } catch { }
    }
    private static void OpenProject(string? link)
    {
        if (link is not ("repository" or "releases")) return;
        Process.Start(new ProcessStartInfo(Policy.Repository + (link == "releases" ? "/releases" : "")) { UseShellExecute = true });
    }
    private void OpenCodex(Guid? thread = null)
    {
        var uri = thread.HasValue ? "codex://threads/" + thread.Value.ToString("D") : "codex://";
        try { Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true }); }
        catch { status.Text = "无法打开官方 Codex，请确认它已安装并正在运行。"; }
    }
    private async Task Send(string type)
    {
        if (helper is null || helper.HasExited) { status.Text = "助手未连接，请从通知区域重新连接。"; return; }
        try { await helper.StandardInput.WriteLineAsync(JsonSerializer.Serialize(new { type, id = ++commandId })); await helper.StandardInput.FlushAsync(); }
        catch { status.Text = "助手连接已停止。"; }
    }
    private void ShowManager() { Show(); WindowState = FormWindowState.Normal; Activate(); }
    private async Task QuitAsync()
    {
        if (quitting) return;
        if (rooms > 0 && MessageBox.Show("退出将结束当前共享，原邀请不会自动恢复。继续退出？", "Codex Co²", MessageBoxButtons.OKCancel) != DialogResult.OK) return;
        quitting = true;
        var process = helper;
        await Send("shutdown");
        if (process is not null)
        {
            try { using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10)); await process.WaitForExitAsync(timeout.Token); } catch { }
        }
        Close();
    }
    private void Cleanup()
    {
        quitting = true; owner = null;
        try { helper?.StandardInput.Close(); } catch { }
        job.Dispose(); tray.Visible = false; tray.Dispose(); view.Dispose();
        try { Directory.Delete(webSession, true); } catch { /* Private session cache remains under ignored .coop only. */ }
    }
}

// All processes created by our helper belong to this private job. Closing the
// native window process cannot leave a cloudflared child serving old shares.
internal sealed class JobScope : IDisposable
{
    private IntPtr handle;
    public JobScope()
    {
        handle = CreateJobObject(IntPtr.Zero, null);
        if (handle == IntPtr.Zero) throw new IOException("Could not create helper job");
        var info = new ExtendedLimits(); info.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        var size = Marshal.SizeOf<ExtendedLimits>(); var ptr = Marshal.AllocHGlobal(size);
        try { Marshal.StructureToPtr(info, ptr, false); if (!SetInformationJobObject(handle, 9, ptr, (uint)size)) throw new IOException("Could not protect helper lifecycle"); }
        finally { Marshal.FreeHGlobal(ptr); }
    }
    public void Assign(Process process) { if (!AssignProcessToJobObject(handle, process.Handle)) { try { process.Kill(true); } catch { } throw new IOException("Could not contain helper process"); } }
    public void Dispose() { if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; } }
    [StructLayout(LayoutKind.Sequential)] private struct BasicLimits { public long ProcessUserTimeLimit, JobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)] private struct IoCounters { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimits { public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr CreateJobObject(IntPtr attributes, string? name);
    [DllImport("kernel32.dll")] private static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr data, uint size);
    [DllImport("kernel32.dll")] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr value);
}
