/*
 * The Win32 side of window embedding (electron/platform/window-embed.ts), as the source of a PowerShell host: C# compiled
 * once with Add-Type, then one command per stdin line, one answer per stdout line ("<id> ok <result>" / "<id> err <why>").
 *
 *   find <exe path>            → the app's main window (visible, unowned, titled), or 0
 *   attach <hwnd> <owner hwnd> → frameless, off the taskbar, owned by Jarod-OS (it stays above it and minimises with it)
 *   place <hwnd> x y w h       → physical screen pixels; shows it
 *   hide <hwnd>
 *   release <hwnd>             → its frame, taskbar button and independence back, where it is
 *   alive <hwnd>               → 1 or 0
 *
 * An owned window rather than a child (SetParent): a child of another process would share Jarod-OS's input queue, and a
 * hung app would hang the shell with it.
 */

export const EMBED_CSHARP = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class JarodEmbed {
  delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hwnd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);
  [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] static extern IntPtr SetWindowLongPtr(IntPtr hwnd, int index, IntPtr value);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int cmd);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref uint size);

  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }

  const int GWL_STYLE = -16, GWL_EXSTYLE = -20, GWLP_HWNDPARENT = -8;
  const long WS_FRAME = 0x00C00000L | 0x00040000L | 0x00080000L | 0x00020000L | 0x00010000L;
  const long WS_EX_APPWINDOW = 0x00040000L, WS_EX_TOOLWINDOW = 0x00000080L;
  const uint SWP_NOACTIVATE = 0x10, SWP_FRAMECHANGED = 0x20, SWP_SHOWWINDOW = 0x40, SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOZORDER = 0x4;

  class Saved { public IntPtr Style, ExStyle, Owner; }
  static readonly Dictionary<long, Saved> saved = new Dictionary<long, Saved>();
  static bool aware;

  static string ImageOf(uint pid) {
    IntPtr process = OpenProcess(0x1000, false, pid);
    if (process == IntPtr.Zero) return "";
    try {
      var name = new StringBuilder(1024);
      uint size = (uint)name.Capacity;
      return QueryFullProcessImageName(process, 0, name, ref size) ? name.ToString() : "";
    } finally { CloseHandle(process); }
  }

  static long Find(string exe) {
    long found = 0; long area = 0;
    EnumWindows((hwnd, l) => {
      if (!IsWindowVisible(hwnd) && !saved.ContainsKey(hwnd.ToInt64())) return true;
      if (GetWindow(hwnd, 4) != IntPtr.Zero && !saved.ContainsKey(hwnd.ToInt64())) return true; // GW_OWNER
      if (GetWindowTextLength(hwnd) == 0) return true;
      uint pid; GetWindowThreadProcessId(hwnd, out pid);
      if (!string.Equals(ImageOf(pid), exe, StringComparison.OrdinalIgnoreCase)) return true;
      RECT r; GetWindowRect(hwnd, out r);
      long a = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
      if (a > area) { area = a; found = hwnd.ToInt64(); }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  static void Attach(IntPtr hwnd, IntPtr owner) {
    long key = hwnd.ToInt64();
    if (!saved.ContainsKey(key)) {
      saved[key] = new Saved { Style = GetWindowLongPtr(hwnd, GWL_STYLE), ExStyle = GetWindowLongPtr(hwnd, GWL_EXSTYLE), Owner = GetWindowLongPtr(hwnd, GWLP_HWNDPARENT) };
    }
    if (IsZoomed(hwnd) || IsIconic(hwnd)) ShowWindow(hwnd, 9); // SW_RESTORE
    var s = saved[key];
    SetWindowLongPtr(hwnd, GWL_STYLE, new IntPtr(s.Style.ToInt64() & ~WS_FRAME));
    SetWindowLongPtr(hwnd, GWL_EXSTYLE, new IntPtr((s.ExStyle.ToInt64() & ~WS_EX_APPWINDOW) | WS_EX_TOOLWINDOW));
    SetWindowLongPtr(hwnd, GWLP_HWNDPARENT, owner);
    SetWindowPos(hwnd, IntPtr.Zero, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
  }

  static void Release(IntPtr hwnd) {
    Saved s;
    if (!saved.TryGetValue(hwnd.ToInt64(), out s)) return;
    saved.Remove(hwnd.ToInt64());
    if (!IsWindow(hwnd)) return;
    SetWindowLongPtr(hwnd, GWLP_HWNDPARENT, s.Owner);
    SetWindowLongPtr(hwnd, GWL_STYLE, s.Style);
    SetWindowLongPtr(hwnd, GWL_EXSTYLE, s.ExStyle);
    SetWindowPos(hwnd, IntPtr.Zero, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED | SWP_SHOWWINDOW);
  }

  public static string Handle(string line) {
    if (!aware) { aware = true; try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { } }
    string[] p = line.Split(new[] { ' ' }, 2);
    string id = p[0];
    string[] a = p.Length > 1 ? p[1].Split(new[] { ' ' }, 2) : new string[0];
    try {
      string cmd = a.Length > 0 ? a[0] : "";
      string rest = a.Length > 1 ? a[1] : "";
      string[] n = rest.Split(' ');
      switch (cmd) {
        case "find": return id + " ok " + Find(rest);
        case "attach": Attach(new IntPtr(long.Parse(n[0])), new IntPtr(long.Parse(n[1]))); return id + " ok";
        case "place":
          IntPtr w = new IntPtr(long.Parse(n[0]));
          if (!IsWindow(w)) return id + " err gone";
          SetWindowPos(w, IntPtr.Zero, int.Parse(n[1]), int.Parse(n[2]), Math.Max(1, int.Parse(n[3])), Math.Max(1, int.Parse(n[4])), SWP_NOACTIVATE | SWP_NOZORDER | SWP_SHOWWINDOW);
          return id + " ok";
        case "hide": ShowWindow(new IntPtr(long.Parse(n[0])), 0); return id + " ok";
        case "release": Release(new IntPtr(long.Parse(n[0]))); return id + " ok";
        case "alive": return id + " ok " + (IsWindow(new IntPtr(long.Parse(n[0]))) ? "1" : "0");
        default: return id + " err unknown command";
      }
    } catch (Exception e) { return id + " err " + e.Message.Replace('\n', ' '); }
  }
}
`

export const EMBED_HOST_PS1 = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${EMBED_CSHARP}
'@
[Console]::Out.WriteLine('ready')
[Console]::Out.Flush()
while ($null -ne ($line = [Console]::In.ReadLine())) {
  [Console]::Out.WriteLine([JarodEmbed]::Handle($line))
  [Console]::Out.Flush()
}
`
