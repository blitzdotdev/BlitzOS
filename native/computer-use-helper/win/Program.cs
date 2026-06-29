// BlitzOS Windows computer-use helper (skeleton).
//
// Mirrors native/computer-use-helper/main.swift, but on the Windows primitives:
//   AXUIElement tree/act  -> UI Automation (FlaUI)
//   CGEvent click/type/key -> SendInput (P/Invoke)
//   CGWindowList          -> EnumWindows + GetWindowRect
//   ScreenCaptureKit      -> PrintWindow/CopyFromScreen (skeleton) -> Windows.Graphics.Capture (ship)
//
// Transport is IDENTICAL to the Mac helper so computer-use-helper.ts is unchanged:
//   BlitzOS LISTENS on an AF_UNIX socket; this process CONNECTS out to it on launch.
//   In:  {"id":<n>,"cmd":"<name>", ...args}\n
//   Out: {"id":<n>, ...payload}\n      (payload is {"ok":true,...} | {"error":"..."} | {tcc|windows|tree|...})
//
// Commands NOT ported (intentional): chrome_* / automation_status -> route browser ops through the
// CDP layer BlitzOS already has. tcc_* -> Windows has no TCC (returned as granted). osa/scan -> PowerShell.
// pick_* / ax_observe -> stubbed; see TODOs.

using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO.Pipes;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Nodes;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Definitions;
using FlaUI.Core.Identifiers;
using FlaUI.UIA3;

internal static class Program
{
    private static async Task<int> Main(string[] argv)
    {
        // Socket path: argv[0] or BLITZ_HELPER_SOCK (whatever computer-use-helper.ts passes on launch).
        string? sockPath = argv.Length > 0 ? argv[0] : Environment.GetEnvironmentVariable("BLITZ_HELPER_SOCK");
        if (string.IsNullOrEmpty(sockPath)) { Console.Error.WriteLine("no socket path"); return 1; }

        // BlitzOS LISTENS and we CONNECT. The carrier depends on what BlitzOS's server is: Node's
        // node:net uses a Windows NAMED PIPE for an IPC path on win32 (never AF_UNIX), so a path under
        // \\.\pipe\ means connect a pipe client; a plain filesystem path means AF_UNIX (the Mac transport,
        // and the C#-side smoke test). The newline-JSON framing layered on top is identical either way.
        await using Stream transport = ConnectTransport(sockPath);
        using var reader = new StreamReader(transport, Encoding.UTF8);
        await using var writer = new StreamWriter(transport, new UTF8Encoding(false)) { AutoFlush = true, NewLine = "\n" };

        // Every frame is newline-delimited JSON tagged with "type": reply | event | hello. The TS reader
        // (computer-use-helper.ts) routes on msg.type and DROPS anything untyped, so the tag is mandatory.
        // The picker thread also writes here, so serialize every send under a lock.
        var sendLock = new object();
        void Send(JsonObject o) { lock (sendLock) { writer.WriteLine(o.ToJsonString()); } }

        // One UIA instance, one read loop. Commands run SEQUENTIALLY here, which sidesteps UIA's
        // thread-affinity grief. If you parallelize, marshal every FlaUI call onto a single STA thread.
        using var automation = new UIA3Automation();

        // ensure() on the TS side blocks until it sees this hello; without it, nothing else runs.
        Send(new JsonObject
        {
            ["type"] = "hello",
            ["pid"] = Environment.ProcessId,
            ["tcc"] = new JsonObject { ["accessibility"] = true, ["screen"] = true, ["automation"] = true },
        });

        string? line;
        while ((line = await reader.ReadLineAsync()) != null)
        {
            if (line.Length == 0) continue;
            int id = 0;
            string cmd = "";
            JsonObject reply;
            try
            {
                var msg = JsonNode.Parse(line)!.AsObject();
                id = (int?)msg["id"] ?? 0;
                cmd = (string?)msg["cmd"] ?? "";
                reply = Dispatch(cmd, msg, automation, Send);
            }
            catch (Exception e)
            {
                reply = new JsonObject { ["error"] = e.Message };
            }
            reply["type"] = "reply";
            reply["id"] = id;
            Send(reply);
            if (cmd == "quit") { Observe.StopAll(); Picker.StopCmd(); break; }
        }
        return 0;
    }

    // Pick the transport from the path shape. A \\.\pipe\ (or \\?\pipe\) path is a Windows named pipe
    // (what node:net listens on for an IPC path on win32); anything else is an AF_UNIX filesystem socket.
    // Both are returned as a plain Stream so the read/dispatch loop above is transport-agnostic.
    private static Stream ConnectTransport(string path)
    {
        const string pipePrefixDot = @"\\.\pipe\";
        const string pipePrefixQ = @"\\?\pipe\";
        if (path.StartsWith(pipePrefixDot, StringComparison.OrdinalIgnoreCase) ||
            path.StartsWith(pipePrefixQ, StringComparison.OrdinalIgnoreCase))
        {
            // NamedPipeClientStream takes a server ("." = local) + the pipe name WITHOUT the \\.\pipe\
            // prefix. BlitzOS's Node server created it via net.Server.listen("\\\\.\\pipe\\blitzcu-<pid>").
            string name = path.Substring(pipePrefixDot.Length);
            var pipe = new NamedPipeClientStream(".", name, PipeDirection.InOut, PipeOptions.Asynchronous);
            pipe.Connect(8000);
            return pipe;
        }
        var sock = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
        sock.Connect(new UnixDomainSocketEndPoint(path));
        return new NetworkStream(sock, ownsSocket: true);
    }

    private static JsonObject Dispatch(string cmd, JsonObject m, UIA3Automation ua, Action<JsonObject> send) => cmd switch
    {
        "ping"                  => new() { ["pong"] = true },
        "quit"                  => new() { ["ok"] = true },

        // No TCC on Windows. UIA needs no grant; input/capture are largely ungated. Report granted so
        // the TS onboarding flow is satisfied. (The real gate is UIPI/integrity level — see header.)
        "tcc_status" or
        "request_accessibility" or
        "request_screen"        => new() { ["tcc"] = new JsonObject { ["accessibility"] = true, ["screen"] = true, ["automation"] = true } },

        "list_windows"          => new() { ["ok"] = true, ["windows"] = Win.ListWindows() },
        "activate"              => Win.Activate(m),

        "cg_click"              => Input.Click(m),
        "cg_type"               => Input.Type((string?)m["text"] ?? ""),
        "cg_key"                => Input.Key((string?)m["key"] ?? ""),

        "ax_tree" or "ax_read"  => Uia.Tree(m, ua),
        "ax_act"                => Uia.Act(m, ua),

        "screenshot"            => Cap.FullScreen(),
        "window_screenshot"     => Cap.Window(m),

        // Deliberately unported — see header.
        "chrome_pid" or "chrome_list_tabs" or "chrome_js" or "automation_status"
                                => new() { ["error"] = "route browser ops through CDP, not the helper" },
        "osa" or "scan"         => new() { ["error"] = "not on win32 — use PowerShell" },
        "ax_observe"            => Observe.Start(m, ua, send),
        "pick_start"            => Picker.Start(m, send),
        "pick_update"           => Picker.Update(m),
        "pick_stop"             => Picker.StopCmd(),

        _                       => new() { ["error"] = $"unknown cmd: {cmd}" },
    };

    // ---- UIA: tree read + act (replaces AXUIElement) ---------------------------------------------
    private static class Uia
    {
        public static JsonObject Tree(JsonObject m, UIA3Automation ua)
        {
            var root = Root(m, ua);
            if (root is null) return new() { ["error"] = "no root element" };
            int maxDepth = (int?)m["maxDepth"] ?? 12;
            int limit = (int?)m["limit"] ?? 2000;
            int count = 0;
            return new() { ["ok"] = true, ["tree"] = Walk(root, 0, maxDepth, ref count, limit) };
        }

        private static JsonObject Walk(AutomationElement el, int depth, int maxDepth, ref int count, int limit)
        {
            var node = new JsonObject();
            try
            {
                // FlaUI's convenience getters (el.AutomationId, el.Name, el.BoundingRectangle) THROW
                // PropertyNotSupportedException when an element does not expose that property (e.g. top-level
                // Win32 windows have no AutomationId). Reading via Properties.X.ValueOrDefault degrades to a
                // default instead of throwing, so one unsupported property never aborts the whole subtree.
                node["role"] = el.Properties.ControlType.ValueOrDefault.ToString();
                node["name"] = el.Properties.Name.ValueOrDefault ?? "";
                node["id"] = el.Properties.AutomationId.ValueOrDefault ?? "";
                var r = el.Properties.BoundingRectangle.ValueOrDefault;
                node["bounds"] = new JsonObject { ["x"] = r.X, ["y"] = r.Y, ["w"] = r.Width, ["h"] = r.Height };
            }
            catch (Exception e) { node["error"] = e.Message; return node; }

            if (depth >= maxDepth || count >= limit) return node;
            try
            {
                var kids = new JsonArray();
                foreach (var c in el.FindAllChildren())
                {
                    if (count++ >= limit) break;
                    kids.Add(Walk(c, depth + 1, maxDepth, ref count, limit));
                }
                if (kids.Count > 0) node["children"] = kids;
            }
            catch { /* stale element — emit partial */ }
            return node;
        }

        public static JsonObject Act(JsonObject m, UIA3Automation ua)
        {
            var root = Root(m, ua);
            if (root is null) return new() { ["error"] = "no root element" };
            var find = m["find"]?.AsObject();
            var target = Find(root, (string?)find?["role"], (string?)find?["title"], 0, 6000);
            if (target is null) return new() { ["error"] = "element not found" };

            string action = ((string?)m["action"] ?? "").ToLowerInvariant();
            string? value = (string?)m["value"];
            try
            {
                switch (action)
                {
                    case "press" or "invoke":
                        target.Patterns.Invoke.PatternOrDefault?.Invoke();
                        break;
                    case "setvalue" or "set_value":
                        target.Patterns.Value.PatternOrDefault?.SetValue(value ?? "");
                        break;
                    case "toggle":
                        target.Patterns.Toggle.PatternOrDefault?.Toggle();
                        break;
                    case "focus":
                        target.Focus();
                        break;
                    default:
                        return new() { ["error"] = $"unknown action: {action}" };
                }
            }
            catch (Exception e) { return new() { ["error"] = $"action {action} failed: {e.Message}" }; }
            return new() { ["ok"] = true, ["effect"] = new JsonObject { ["action"] = action, ["target"] = target.Name ?? "" } };
        }

        // Manual BFS match (role == ControlType, title substring). Swap for ConditionFactory if you
        // want native-side filtering; this stays readable and dependency-light.
        private static AutomationElement? Find(AutomationElement el, string? role, string? title, int depth, int limit)
        {
            if (limit <= 0) return null;
            try
            {
                bool roleOk = role is null || string.Equals(el.ControlType.ToString(), role, StringComparison.OrdinalIgnoreCase);
                bool titleOk = title is null || (el.Name ?? "").Contains(title, StringComparison.OrdinalIgnoreCase);
                if (depth > 0 && roleOk && titleOk) return el;
            }
            catch { }
            try
            {
                foreach (var c in el.FindAllChildren())
                {
                    var hit = Find(c, role, title, depth + 1, limit - 1);
                    if (hit is not null) return hit;
                }
            }
            catch { }
            return null;
        }

        private static AutomationElement? Root(JsonObject m, UIA3Automation ua)
        {
            // Prefer an explicit HWND; fall back to a pid's main window; else the desktop root.
            if (m["windowId"] is JsonNode w && (long)w != 0)
                return ua.FromHandle(new IntPtr((long)w));
            if (m["pid"] is JsonNode p)
            {
                try { var h = Process.GetProcessById((int)p).MainWindowHandle; if (h != IntPtr.Zero) return ua.FromHandle(h); }
                catch { }
            }
            return ua.GetDesktop();
        }
    }

    // ---- UIA change observation (replaces AXObserver) -------------------------------------------
    private static class Observe
    {
        private static readonly object _lock = new();
        private static readonly Dictionary<int, List<object>> _regs = new(); // pid -> handler refs (keep-alive)
        private static readonly Dictionary<int, long> _lastEmit = new();
        private static object? _focusReg;
        private static Action<JsonObject>? _send;

        public static JsonObject Start(JsonObject m, UIA3Automation ua, Action<JsonObject> send)
        {
            int pid = ResolvePid(m);
            if (pid <= 0) return new() { ["error"] = "pid (or resolvable windowId) required" };

            lock (_lock)
            {
                _send = send;
                if (_regs.ContainsKey(pid)) return new() { ["ok"] = true }; // already observing — mirror the Mac dedup

                var root = RootForPid(ua, pid);
                if (root is null) return new() { ["error"] = "no window for pid" };

                var handlers = new List<object>();
                try
                {
                    // Focus changes are global in UIA — register once, filter by observed pid in the callback.
                    _focusReg ??= ua.RegisterFocusChangedEvent(OnFocus);

                    // Subtree property (Value/Name) + structure changes = the Mac set (value/title/main-window changed).
                    handlers.Add(root.RegisterStructureChangedEvent(TreeScope.Subtree, (_, _, _) => Emit(pid)));
                    handlers.Add(root.RegisterPropertyChangedEvent(TreeScope.Subtree, (_, _, _) => Emit(pid),
                        ua.PropertyLibrary.Value.Value, ua.PropertyLibrary.Element.Name));
                }
                catch (Exception ex) { return new() { ["error"] = $"register failed: {ex.Message}" }; }

                _regs[pid] = handlers;
            }
            return new() { ["ok"] = true };
        }

        private static void OnFocus(AutomationElement el)
        {
            try { int pid = el.Properties.ProcessId.ValueOrDefault; if (Observed(pid)) Emit(pid); } catch { }
        }

        private static bool Observed(int pid) { lock (_lock) { return _regs.ContainsKey(pid); } }

        // UIA Subtree events fire in bursts; the consumer just wakes the agent, so cap to one wake / pid / 250ms.
        private static void Emit(int pid)
        {
            long now = Environment.TickCount64;
            lock (_lock)
            {
                if (_lastEmit.TryGetValue(pid, out long last) && now - last < 250) return;
                _lastEmit[pid] = now;
            }
            _send?.Invoke(new JsonObject { ["type"] = "event", ["kind"] = "ax_changed", ["pid"] = pid });
        }

        // Mac never unregisters either — observers live until quit, so this just drops the keep-alive refs and
        // lets process teardown release the COM handlers. (Per-pid unregister isn't needed for the MVP.)
        public static void StopAll()
        {
            lock (_lock) { _regs.Clear(); _focusReg = null; _lastEmit.Clear(); }
        }

        private static int ResolvePid(JsonObject m)
        {
            if (m["pid"] is JsonNode p) return (int)p;
            if (m["windowId"] is JsonNode w && (long)w != 0)
            {
                Native.GetWindowThreadProcessId(new IntPtr((long)w), out uint pid);
                return (int)pid;
            }
            return -1;
        }

        private static AutomationElement? RootForPid(UIA3Automation ua, int pid)
        {
            try { var h = Process.GetProcessById(pid).MainWindowHandle; if (h != IntPtr.Zero) return ua.FromHandle(h); }
            catch { }
            return null;
        }
    }

    // ---- Synthetic input: SendInput (replaces CGEvent) -------------------------------------------
    private static class Input
    {
        public static JsonObject Click(JsonObject m)
        {
            var (x, y) = ResolvePoint(m);
            Native.SetCursorPos(x, y);
            bool right = (string?)m["button"] == "right";
            Send(Mouse(right ? Native.MOUSEEVENTF_RIGHTDOWN : Native.MOUSEEVENTF_LEFTDOWN));
            Send(Mouse(right ? Native.MOUSEEVENTF_RIGHTUP : Native.MOUSEEVENTF_LEFTUP));
            // Mac emits effect.clicked (main.swift cg_click); match the key for byte-parity.
            return new() { ["ok"] = true, ["effect"] = new JsonObject { ["clicked"] = new JsonObject { ["x"] = x, ["y"] = y } } };
        }

        public static JsonObject Type(string text)
        {
            foreach (var ch in text)
            {
                Send(KeyUnicode(ch, false));
                Send(KeyUnicode(ch, true));
            }
            return new() { ["ok"] = true, ["effect"] = new JsonObject { ["typed"] = text } };
        }

        // "ctrl+shift+c" / "cmd+c" / "enter". cmd|meta|super -> Ctrl (the cross-platform-shortcut
        // convention); win -> the actual Windows key. Adjust if your agent emits literal Windows specs.
        public static JsonObject Key(string spec)
        {
            var parts = spec.Split('+', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            if (parts.Length == 0) return new() { ["error"] = "empty key" };
            var mods = new List<ushort>();
            ushort? key = null;
            foreach (var raw in parts)
            {
                var t = raw.ToLowerInvariant();
                if (Mod(t) is ushort mv) mods.Add(mv);
                else if (Vk(t) is ushort kv) key = kv;
                else return new() { ["error"] = $"unknown key token: {raw}" };
            }
            if (key is null) return new() { ["error"] = "no non-modifier key" };
            foreach (var mv in mods) Send(KeyVk(mv, false));
            Send(KeyVk(key.Value, false));
            Send(KeyVk(key.Value, true));
            for (int i = mods.Count - 1; i >= 0; i--) Send(KeyVk(mods[i], true));
            return new() { ["ok"] = true, ["effect"] = new JsonObject { ["key"] = spec } };
        }

        private static (int x, int y) ResolvePoint(JsonObject m)
        {
            // Absolute screen coords (x,y), or window-relative fractions (windowId + px,py 0..1).
            if (m["windowId"] is JsonNode w && (long)w != 0 && m["px"] is not null && m["py"] is not null)
            {
                if (Native.GetWindowRect(new IntPtr((long)w), out var r))
                {
                    double px = (double)m["px"]!, py = (double)m["py"]!;
                    return (r.Left + (int)((r.Right - r.Left) * px), r.Top + (int)((r.Bottom - r.Top) * py));
                }
            }
            return ((int?)m["x"] ?? 0, (int?)m["y"] ?? 0);
        }

        private static ushort? Mod(string t) => t switch
        {
            "ctrl" or "control" => 0x11,
            "shift" => 0x10,
            "alt" or "option" => 0x12,
            "cmd" or "meta" or "super" => 0x11, // -> Ctrl
            "win" => 0x5B,
            _ => null,
        };

        private static ushort? Vk(string t)
        {
            if (t.Length == 1 && char.IsLetterOrDigit(t[0])) return char.ToUpperInvariant(t[0]);
            return t switch
            {
                "enter" or "return" => 0x0D,
                "tab" => 0x09,
                "esc" or "escape" => 0x1B,
                "space" => 0x20,
                "backspace" => 0x08,
                "delete" => 0x2E,
                "up" => 0x26, "down" => 0x28, "left" => 0x25, "right" => 0x27,
                "home" => 0x24, "end" => 0x23, "pageup" => 0x21, "pagedown" => 0x22,
                _ => null,
            };
        }

        private static Native.INPUT Mouse(uint flags) => new()
        {
            type = Native.INPUT_MOUSE,
            U = new Native.InputUnion { mi = new Native.MOUSEINPUT { dwFlags = flags } }
        };

        private static Native.INPUT KeyUnicode(char ch, bool up) => new()
        {
            type = Native.INPUT_KEYBOARD,
            U = new Native.InputUnion
            {
                ki = new Native.KEYBDINPUT
                {
                    wVk = 0,
                    wScan = ch,
                    dwFlags = Native.KEYEVENTF_UNICODE | (up ? Native.KEYEVENTF_KEYUP : 0)
                }
            }
        };

        private static Native.INPUT KeyVk(ushort vk, bool up) => new()
        {
            type = Native.INPUT_KEYBOARD,
            U = new Native.InputUnion { ki = new Native.KEYBDINPUT { wVk = vk, dwFlags = up ? Native.KEYEVENTF_KEYUP : 0 } }
        };

        private static void Send(Native.INPUT input)
        {
            var arr = new[] { input };
            Native.SendInput(1, arr, Marshal.SizeOf<Native.INPUT>());
        }
    }

    // ---- Windows: enumerate + activate (replaces CGWindowList) -----------------------------------
    private static class Win
    {
        public static JsonArray ListWindows()
        {
            var list = new JsonArray();
            Native.EnumWindows((h, _) =>
            {
                if (!Native.IsWindowVisible(h)) return true;
                int len = Native.GetWindowTextLength(h);
                if (len == 0) return true;
                var sb = new StringBuilder(len + 1);
                Native.GetWindowText(h, sb, sb.Capacity);
                if (!Native.GetWindowRect(h, out var r)) return true;
                if (r.Right - r.Left <= 0 || r.Bottom - r.Top <= 0) return true;

                Native.GetWindowThreadProcessId(h, out uint pid);
                string app = "";
                try { app = Process.GetProcessById((int)pid).ProcessName; } catch { }

                list.Add(new JsonObject
                {
                    ["windowId"] = h.ToInt64(),
                    ["pid"] = (int)pid,
                    ["app"] = app,
                    ["title"] = sb.ToString(),
                    ["bounds"] = new JsonObject { ["x"] = r.Left, ["y"] = r.Top, ["w"] = r.Right - r.Left, ["h"] = r.Bottom - r.Top },
                });
                return true;
            }, IntPtr.Zero);
            return list;
        }

        public static JsonObject Activate(JsonObject m)
        {
            IntPtr h = IntPtr.Zero;
            if (m["windowId"] is JsonNode w && (long)w != 0) h = new IntPtr((long)w);
            else if (m["pid"] is JsonNode p) { try { h = Process.GetProcessById((int)p).MainWindowHandle; } catch { } }
            if (h == IntPtr.Zero) return new() { ["error"] = "no window" };
            bool ok = Native.ForceForeground(h);
            return new() { ["ok"] = ok };
        }
    }

    // ---- Capture (skeleton). Ship: Windows.Graphics.Capture for occluded/GPU content -------------
    private static class Cap
    {
        public static JsonObject FullScreen()
        {
            var b = Native.VirtualScreenBounds();
            using var bmp = new Bitmap(b.Width, b.Height, PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(bmp)) g.CopyFromScreen(b.X, b.Y, 0, 0, b.Size);
            return new() { ["ok"] = true, ["png"] = ToB64(bmp) };
        }

        public static JsonObject Window(JsonObject m)
        {
            if (m["windowId"] is not JsonNode w || (long)w == 0) return new() { ["error"] = "windowId required" };
            IntPtr h = new((long)w);
            if (!Native.GetWindowRect(h, out var r)) return new() { ["error"] = "GetWindowRect failed" };
            using var bmp = new Bitmap(r.Right - r.Left, r.Bottom - r.Top, PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(bmp))
            {
                IntPtr hdc = g.GetHdc();
                // PW_RENDERFULLCONTENT (2) grabs many GPU/DWM surfaces PrintWindow used to miss. Still
                // returns black for SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE) windows — by design.
                Native.PrintWindow(h, hdc, 2);
                g.ReleaseHdc(hdc);
            }
            return new() { ["ok"] = true, ["png"] = ToB64(bmp) };
        }

        private static string ToB64(Bitmap bmp)
        {
            using var ms = new MemoryStream();
            bmp.Save(ms, ImageFormat.Png);
            return Convert.ToBase64String(ms.ToArray());
        }
    }

    // ---- P/Invoke ---------------------------------------------------------------------------------
    private static class Native
    {
        public const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
        public const uint MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;
        public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010;
        public const uint KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;

        [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
        [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion U; }

        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int cb);
        [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
        [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int max);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
        [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
        [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();

        public const int SW_RESTORE = 9;

        // SetForegroundWindow alone obeys Windows' focus-stealing rules and silently no-ops when the
        // caller isn't already the foreground process. Briefly attaching our input queue to the current
        // foreground thread's queue lifts that restriction for the duration of the call — the standard
        // recipe. (Some locked-down setups still need SystemParametersInfo(SPI_SETFOREGROUNDLOCKTIMEOUT,0).)
        public static bool ForceForeground(IntPtr h)
        {
            if (IsIconic(h)) ShowWindow(h, SW_RESTORE);
            uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), out _);
            uint thisThread = GetCurrentThreadId();
            bool attached = fgThread != thisThread && AttachThreadInput(fgThread, thisThread, true);
            BringWindowToTop(h);
            bool ok = SetForegroundWindow(h);
            if (attached) AttachThreadInput(fgThread, thisThread, false);
            return ok;
        }
        [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
        [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);

        public static Rectangle VirtualScreenBounds() =>
            new(GetSystemMetrics(76), GetSystemMetrics(77), GetSystemMetrics(78), GetSystemMetrics(79)); // SM_*VIRTUALSCREEN
    }
}
