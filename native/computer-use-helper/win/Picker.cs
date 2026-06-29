// Drag-to-attach picker (replaces the Mac CGEventTap + NSPanel highlight).
//
// Mac parity: arm a global pointer watch, hit-test the front normal window under the cursor (skipping
// BlitzOS's island via selfRect, our own overlays, and excludePids), glow-highlight it, and emit:
//   pick_hover {windowId,pid,app,title}   on a new hovered window
//   pick_over  {inside}                    when the drag crosses the drop-zone boundary
//   pick_drop  {windowId,pid,app,title,icon} on mouse-up INSIDE the drop zone
//   pick_cancel                            on mouse-up outside it
// All as {type:"event", kind:...} frames, matching native/computer-use-helper/main.swift.
//
// Mechanics that differ from macOS:
//   * WH_MOUSE_LL is a global hook whose callback fires on the installing thread's message loop — so the
//     picker owns a dedicated STA thread that installs the hook, creates the overlays, and pumps messages.
//   * "Swallowing" the grab click = returning (IntPtr)1 instead of CallNextHookEx, so the OS never starts
//     a window-drag or shifts focus on mouse-down.
//   * Highlight is a WS_EX_LAYERED|WS_EX_TRANSPARENT (click-through) topmost window painted via
//     UpdateLayeredWindow with PREMULTIPLIED alpha (the usual gotcha — GetHbitmap doesn't premultiply).
//
// Skeleton edges to polish: the glow is a simple multi-pass stroke; per-monitor DPI isn't handled
// (mix-and-match scaling will misplace the overlay); the keep-alive of the hook/wndproc delegates is
// load-bearing (GC them and the process crashes mid-gesture).

using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Nodes;

internal sealed class Picker
{
    private static Picker? _active;
    private static readonly object _gate = new();

    private readonly Action<JsonObject> _emit;
    private RECT _dropZone;
    private RECT _selfRect;
    private readonly HashSet<int> _exclude = new();

    private Thread? _thread;
    private uint _threadId;
    private IntPtr _hook;
    private N.HookProc? _hookProc;     // keep alive — GC here == crash
    private LayeredWindow? _glow;
    private LayeredWindow? _icon;

    // gesture state (all touched only on the picker thread)
    private IntPtr _hoverRoot;
    private IntPtr _grabbed;
    private bool _dragging;
    private bool _lastInside;

    private Picker(JsonObject m, Action<JsonObject> emit)
    {
        _emit = emit;
        _dropZone = RectFrom(m["dropZone"]);
        _selfRect = RectFrom(m["selfRect"]);
        if (m["excludePids"] is JsonArray pids)
            foreach (var p in pids) if (p is not null) _exclude.Add((int)p);
    }

    // ---- command surface (called from the main read loop) ---------------------------------------
    public static JsonObject Start(JsonObject m, Action<JsonObject> emit)
    {
        lock (_gate)
        {
            StopLocked();
            var p = new Picker(m, emit);
            _active = p;
            p._thread = new Thread(p.Run) { IsBackground = true, Name = "blitz-picker" };
            p._thread.SetApartmentState(ApartmentState.STA);
            p._thread.Start();
            return new JsonObject { ["ok"] = true };
        }
    }

    public static JsonObject Update(JsonObject m)
    {
        lock (_gate) { if (_active is not null) _active._dropZone = RectFrom(m["dropZone"]); }
        return new JsonObject { ["ok"] = true };
    }

    public static JsonObject StopCmd()
    {
        lock (_gate) StopLocked();
        return new JsonObject { ["ok"] = true };
    }

    private static void StopLocked()
    {
        var p = _active;
        _active = null;
        if (p is null) return;
        // Break GetMessage; the thread tears down hook + overlays after the loop exits.
        for (int i = 0; i < 50 && p._threadId == 0; i++) Thread.Sleep(2); // thread may not have armed yet
        if (p._threadId != 0) N.PostThreadMessage(p._threadId, N.WM_QUIT, IntPtr.Zero, IntPtr.Zero);
    }

    // ---- picker thread --------------------------------------------------------------------------
    private void Run()
    {
        _threadId = N.GetCurrentThreadId();
        _glow = LayeredWindow.Create();
        _icon = LayeredWindow.Create();
        _hookProc = HookCallback;
        _hook = N.SetWindowsHookEx(N.WH_MOUSE_LL, _hookProc, N.GetModuleHandle(null), 0);

        while (N.GetMessage(out var msg, IntPtr.Zero, 0, 0) > 0)
        {
            N.TranslateMessage(ref msg);
            N.DispatchMessage(ref msg);
        }

        if (_hook != IntPtr.Zero) N.UnhookWindowsHookEx(_hook);
        _glow?.Dispose();
        _icon?.Dispose();
        _hook = IntPtr.Zero;
        _hookProc = null;
    }

    private IntPtr HookCallback(int code, IntPtr wParam, IntPtr lParam)
    {
        if (code >= 0)
        {
            var data = Marshal.PtrToStructure<N.MSLLHOOKSTRUCT>(lParam);
            var pt = data.pt;
            switch ((int)wParam)
            {
                case N.WM_MOUSEMOVE:
                    if (_dragging) MoveDrag(pt); else UpdateHover(pt);
                    break;
                case N.WM_LBUTTONDOWN:
                    if (!_dragging && _hoverRoot != IntPtr.Zero) { BeginDrag(pt); return (IntPtr)1; } // swallow grab
                    break;
                case N.WM_LBUTTONUP:
                    if (_dragging) { EndDrag(pt); return (IntPtr)1; }
                    break;
            }
        }
        return N.CallNextHookEx(_hook, code, wParam, lParam);
    }

    // ---- hover / hit-test -----------------------------------------------------------------------
    private void UpdateHover(POINT p)
    {
        var root = FrontWindowAt(p);
        if (root == _hoverRoot) return;
        _hoverRoot = root;
        if (root == IntPtr.Zero) { _glow?.Hide(); return; }
        N.GetWindowRect(root, out var r);
        float scale = N.GetDpiForWindow(root) / 96f;
        if (scale <= 0) scale = 1f;
        _glow?.PaintGlow(r, scale);
        EmitWindow("pick_hover", root);
    }

    // Front NORMAL top-level window under the cursor, skipping the island chassis, our overlays, and
    // excluded pids. WindowFromPoint already ignores WS_EX_TRANSPARENT windows, so our click-through
    // overlays don't shadow the hit-test.
    private IntPtr FrontWindowAt(POINT p)
    {
        if (PointIn(_selfRect, p)) return IntPtr.Zero;
        var h = N.WindowFromPoint(p);
        if (h == IntPtr.Zero) return IntPtr.Zero;
        var root = N.GetAncestor(h, N.GA_ROOT);
        if (root == IntPtr.Zero || root == _glow?.Handle || root == _icon?.Handle) return IntPtr.Zero;
        if (!N.IsWindowVisible(root)) return IntPtr.Zero;
        N.GetWindowThreadProcessId(root, out uint pid);
        if (_exclude.Contains((int)pid)) return IntPtr.Zero;
        if (!N.GetWindowRect(root, out var r)) return IntPtr.Zero;
        if (r.Right - r.Left < 40 || r.Bottom - r.Top < 40) return IntPtr.Zero; // skip slivers / tooltips
        return root;
    }

    // ---- drag -----------------------------------------------------------------------------------
    private void BeginDrag(POINT p)
    {
        _dragging = true;
        _grabbed = _hoverRoot;
        _lastInside = PointIn(_dropZone, p);
        _glow?.Hide();
        using var ico = WindowIconBitmap(_grabbed, 48);
        if (ico is not null) _icon?.PaintAt(ico, p.x - 24, p.y - 24);
    }

    private void MoveDrag(POINT p)
    {
        _icon?.MoveTo(p.x - 24, p.y - 24);
        bool inside = PointIn(_dropZone, p);
        if (inside != _lastInside)
        {
            _lastInside = inside;
            _emit(Event("pick_over", new JsonObject { ["inside"] = inside }));
        }
    }

    private void EndDrag(POINT p)
    {
        _dragging = false;
        _icon?.Hide();
        if (PointIn(_dropZone, p) && _grabbed != IntPtr.Zero)
        {
            var extra = new JsonObject();
            var b64 = WindowIconB64(_grabbed);
            if (b64 is not null) extra["icon"] = b64;
            EmitWindow("pick_drop", _grabbed, extra);
        }
        else _emit(Event("pick_cancel"));
        _grabbed = IntPtr.Zero;
        _hoverRoot = IntPtr.Zero;
    }

    // ---- event helpers --------------------------------------------------------------------------
    private void EmitWindow(string kind, IntPtr root, JsonObject? extra = null)
    {
        N.GetWindowThreadProcessId(root, out uint pid);
        var o = Event(kind, extra);
        o["windowId"] = root.ToInt64();
        o["pid"] = (int)pid;
        o["app"] = ProcName((int)pid);
        o["title"] = WindowTitle(root);
        _emit(o);
    }

    private static JsonObject Event(string kind, JsonObject? extra = null)
    {
        var o = new JsonObject { ["type"] = "event", ["kind"] = kind };
        if (extra is not null) foreach (var kv in extra) o[kv.Key] = kv.Value?.DeepClone();
        return o;
    }

    // ---- small utilities ------------------------------------------------------------------------
    private static bool PointIn(RECT r, POINT p) => p.x >= r.Left && p.x < r.Right && p.y >= r.Top && p.y < r.Bottom;

    private static RECT RectFrom(JsonNode? n)
    {
        if (n is not JsonObject o) return default;
        int x = (int?)o["x"] ?? 0, y = (int?)o["y"] ?? 0, w = (int?)o["w"] ?? 0, h = (int?)o["h"] ?? 0;
        return new RECT { Left = x, Top = y, Right = x + w, Bottom = y + h };
    }

    private static string ProcName(int pid)
    {
        try { return System.Diagnostics.Process.GetProcessById(pid).ProcessName; } catch { return ""; }
    }

    private static string WindowTitle(IntPtr h)
    {
        int len = N.GetWindowTextLength(h);
        if (len == 0) return "";
        var sb = new StringBuilder(len + 1);
        N.GetWindowText(h, sb, sb.Capacity);
        return sb.ToString();
    }

    private static IntPtr WindowIcon(IntPtr h)
    {
        N.SendMessageTimeout(h, N.WM_GETICON, (IntPtr)1 /*ICON_BIG*/, IntPtr.Zero, 0, 200, out var r);
        if (r == IntPtr.Zero) r = N.GetClassLongPtr(h, N.GCLP_HICON);
        if (r == IntPtr.Zero) N.SendMessageTimeout(h, N.WM_GETICON, IntPtr.Zero /*ICON_SMALL*/, IntPtr.Zero, 0, 200, out r);
        return r;
    }

    private static Bitmap? WindowIconBitmap(IntPtr h, int size)
    {
        var hic = WindowIcon(h);
        if (hic == IntPtr.Zero) return null;
        try
        {
            using var ico = Icon.FromHandle(hic);
            var bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb);
            using var g = Graphics.FromImage(bmp);
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.DrawIcon(ico, new Rectangle(0, 0, size, size));
            return bmp;
        }
        catch { return null; }
    }

    private static string? WindowIconB64(IntPtr h)
    {
        using var bmp = WindowIconBitmap(h, 64);
        if (bmp is null) return null;
        using var ms = new MemoryStream();
        bmp.Save(ms, ImageFormat.Png);
        return Convert.ToBase64String(ms.ToArray());
    }

    // ===== Layered click-through overlay window ======================================================
    private sealed class LayeredWindow : IDisposable
    {
        public IntPtr Handle { get; private set; }
        private static N.WndProc? _wndProc;
        private static ushort _atom;

        public static LayeredWindow Create()
        {
            EnsureClass();
            const uint ex = N.WS_EX_LAYERED | N.WS_EX_TRANSPARENT | N.WS_EX_TOPMOST | N.WS_EX_TOOLWINDOW | N.WS_EX_NOACTIVATE;
            var h = N.CreateWindowEx(ex, new IntPtr(_atom), null, unchecked((int)N.WS_POPUP),
                0, 0, 0, 0, IntPtr.Zero, IntPtr.Zero, N.GetModuleHandle(null), IntPtr.Zero);
            return new LayeredWindow { Handle = h };
        }

        private static void EnsureClass()
        {
            if (_atom != 0) return;
            _wndProc = (h, m, w, l) => N.DefWindowProc(h, m, w, l);
            var wc = new N.WNDCLASSEX
            {
                cbSize = Marshal.SizeOf<N.WNDCLASSEX>(),
                lpfnWndProc = Marshal.GetFunctionPointerForDelegate(_wndProc),
                hInstance = N.GetModuleHandle(null),
                lpszClassName = "BlitzPickerOverlay",
            };
            _atom = N.RegisterClassEx(ref wc);
        }

        // Glow = a few inset rectangle strokes with falling alpha around the target bounds. Pad + stroke
        // widths scale with the target monitor's DPI so the outline reads the same on 100% and 200% displays.
        public void PaintGlow(RECT target, float scale = 1f)
        {
            int pad = (int)MathF.Round(6 * scale);
            int w = (target.Right - target.Left) + pad * 2;
            int h = (target.Bottom - target.Top) + pad * 2;
            if (w <= 0 || h <= 0) return;
            using var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.Clear(Color.Transparent);
                var accent = Color.FromArgb(95, 205, 255);
                for (int i = 5; i >= 1; i--)
                {
                    int a = 28 + (5 - i) * 24;        // outer faint -> inner bright
                    using var pen = new Pen(Color.FromArgb(a, accent), i * 1.6f * scale);
                    float o = i * scale; // inset
                    g.DrawRectangle(pen, o, o, w - 1 - o * 2, h - 1 - o * 2);
                }
            }
            PaintAt(bmp, target.Left - pad, target.Top - pad);
        }

        public void PaintAt(Bitmap bmp, int x, int y)
        {
            N.ShowWindow(Handle, N.SW_SHOWNA);
            IntPtr screen = N.GetDC(IntPtr.Zero);
            IntPtr mem = N.CreateCompatibleDC(screen);
            IntPtr dib = MakePremultipliedDib(mem, bmp, out IntPtr old);
            try
            {
                var size = new SIZE { cx = bmp.Width, cy = bmp.Height };
                var dst = new POINT { x = x, y = y };
                var src = new POINT { x = 0, y = 0 };
                var blend = new N.BLENDFUNCTION { BlendOp = 0, BlendFlags = 0, SourceConstantAlpha = 255, AlphaFormat = 1 };
                N.UpdateLayeredWindow(Handle, screen, ref dst, ref size, mem, ref src, 0, ref blend, N.ULW_ALPHA);
            }
            finally
            {
                N.SelectObject(mem, old);
                N.DeleteObject(dib);
                N.DeleteDC(mem);
                N.ReleaseDC(IntPtr.Zero, screen);
            }
        }

        public void MoveTo(int x, int y) =>
            N.SetWindowPos(Handle, N.HWND_TOPMOST, x, y, 0, 0, N.SWP_NOSIZE | N.SWP_NOACTIVATE);

        public void Hide() => N.ShowWindow(Handle, N.SW_HIDE);

        // UpdateLayeredWindow demands a premultiplied-alpha 32bpp DIB. Managed Format32bppArgb is
        // straight alpha, so premultiply per pixel into a top-down DIBSection.
        private static unsafe IntPtr MakePremultipliedDib(IntPtr memDc, Bitmap bmp, out IntPtr old)
        {
            int w = bmp.Width, hgt = bmp.Height;
            var bi = new N.BITMAPINFO
            {
                biSize = 40, biWidth = w, biHeight = -hgt, biPlanes = 1, biBitCount = 32, biCompression = 0,
            };
            IntPtr dib = N.CreateDIBSection(memDc, ref bi, 0, out IntPtr bits, IntPtr.Zero, 0);
            old = N.SelectObject(memDc, dib);

            var rect = new Rectangle(0, 0, w, hgt);
            var ld = bmp.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            byte* s = (byte*)ld.Scan0;       // BGRA, straight alpha
            byte* d = (byte*)bits;           // BGRA, premultiplied
            int count = w * hgt;
            for (int i = 0; i < count; i++)
            {
                byte a = s[3];
                d[0] = (byte)(s[0] * a / 255);
                d[1] = (byte)(s[1] * a / 255);
                d[2] = (byte)(s[2] * a / 255);
                d[3] = a;
                s += 4; d += 4;
            }
            bmp.UnlockBits(ld);
            return dib;
        }

        public void Dispose()
        {
            if (Handle != IntPtr.Zero) { N.DestroyWindow(Handle); Handle = IntPtr.Zero; }
        }
    }
}

// ===== P/Invoke surface for the picker ==============================================================
internal static class N
{
    public const int WH_MOUSE_LL = 14;
    public const int WM_MOUSEMOVE = 0x0200, WM_LBUTTONDOWN = 0x0201, WM_LBUTTONUP = 0x0202, WM_QUIT = 0x0012;
    public const int WM_GETICON = 0x007F;
    public const int GA_ROOT = 2, GCLP_HICON = -14;
    public const uint WS_POPUP = 0x80000000;
    public const uint WS_EX_LAYERED = 0x00080000, WS_EX_TRANSPARENT = 0x00000020, WS_EX_TOPMOST = 0x00000008,
                      WS_EX_TOOLWINDOW = 0x00000080, WS_EX_NOACTIVATE = 0x08000000;
    public const int SW_HIDE = 0, SW_SHOWNA = 8;
    public const uint ULW_ALPHA = 2;
    public const uint SWP_NOSIZE = 0x0001, SWP_NOACTIVATE = 0x0010;
    public static readonly IntPtr HWND_TOPMOST = new(-1);

    public delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);
    public delegate IntPtr WndProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)] public struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData, flags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct BLENDFUNCTION { public byte BlendOp, BlendFlags, SourceConstantAlpha, AlphaFormat; }
    [StructLayout(LayoutKind.Sequential)]
    public struct BITMAPINFO { public int biSize, biWidth, biHeight; public short biPlanes, biBitCount; public int biCompression, biSizeImage, biXPelsPerMeter, biYPelsPerMeter, biClrUsed, biClrImportant; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct WNDCLASSEX
    {
        public int cbSize, style; public IntPtr lpfnWndProc; public int cbClsExtra, cbWndExtra;
        public IntPtr hInstance, hIcon, hCursor, hbrBackground;
        [MarshalAs(UnmanagedType.LPWStr)] public string? lpszMenuName;
        [MarshalAs(UnmanagedType.LPWStr)] public string? lpszClassName;
        public IntPtr hIconSm;
    }

    [DllImport("user32.dll")] public static extern IntPtr SetWindowsHookEx(int id, HookProc fn, IntPtr hMod, uint thread);
    [DllImport("user32.dll")] public static extern bool UnhookWindowsHookEx(IntPtr hHook);
    [DllImport("user32.dll")] public static extern IntPtr CallNextHookEx(IntPtr hHook, int code, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern int GetMessage(out MSG msg, IntPtr hWnd, uint min, uint max);
    [DllImport("user32.dll")] public static extern bool TranslateMessage(ref MSG msg);
    [DllImport("user32.dll")] public static extern IntPtr DispatchMessage(ref MSG msg);
    [DllImport("user32.dll")] public static extern bool PostThreadMessage(uint thread, int msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, int flags);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern ushort RegisterClassEx(ref WNDCLASSEX c);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateWindowEx(uint ex, IntPtr cls, string? name, int style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);
    [DllImport("user32.dll")] public static extern IntPtr DefWindowProc(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern bool DestroyWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern bool UpdateLayeredWindow(IntPtr h, IntPtr dst, ref POINT pDst, ref SIZE size, IntPtr src, ref POINT pSrc, uint key, ref BLENDFUNCTION blend, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr h);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr dc);
    [DllImport("user32.dll", EntryPoint = "GetClassLongPtrW")] public static extern IntPtr GetClassLongPtr(IntPtr h, int index);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr h, int msg, IntPtr w, IntPtr l, uint flags, uint ms, out IntPtr result);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr GetModuleHandle(string? name);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateDIBSection(IntPtr dc, ref BITMAPINFO bmi, uint usage, out IntPtr bits, IntPtr section, uint offset);
}

// Shared simple structs (kept here so Picker.cs compiles standalone alongside Program.cs).
[StructLayout(LayoutKind.Sequential)] internal struct RECT { public int Left, Top, Right, Bottom; }
[StructLayout(LayoutKind.Sequential)] internal struct POINT { public int x, y; }
[StructLayout(LayoutKind.Sequential)] internal struct SIZE { public int cx, cy; }
[StructLayout(LayoutKind.Sequential)] internal struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public POINT pt; }
