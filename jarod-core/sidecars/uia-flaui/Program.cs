// Sidecar UI Automation (FlaUI, UIA3) : les sept opérations sémantiques du sidecar pywinauto, plus (2026-10-21, autonomie configurable) le clavier
// (combinaisons, frappe brute) et la souris (clic et défilement par coordonnées RELATIVES à la fenêtre).
// Une ligne JSON par requête sur stdin {"id","op","args"}, une ligne JSON par réponse sur stdout {"id","ok","result"|"error"} ; un événement spontané
// {"event":"emergency_stop"} quand l'utilisateur presse Ctrl+Alt+Fin.
// La politique (fenêtres, permissions, accord, débit, combinaisons système refusées) est appliquée par l'hôte AVANT l'envoi. Ce processus ajoute ce
// que seul lui peut constater au moment d'agir : la fenêtre visée est AU PREMIER PLAN avant toute entrée clavier, et un point de clic tombe DANS la
// fenêtre visée (pas sur une autre fenêtre qui la recouvre). Le curseur est remis à sa place après un geste de souris.
// Arrêt d'urgence : Ctrl+Alt+Fin, lu au clavier physique ; ensuite toute opération est refusée jusqu'à ce que l'hôte relance le processus.
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Definitions;
using FlaUI.Core.Input;
using FlaUI.Core.WindowsAPI;
using FlaUI.UIA3;

Console.OutputEncoding = new System.Text.UTF8Encoding(false);
using var automation = new UIA3Automation();
var windows = new Dictionary<string, Window>();
var elements = new Dictionary<string, AutomationElement>();
var outLock = new object();
var stopped = false;

void Send(JsonObject o)
{
    lock (outLock)
    {
        Console.WriteLine(o.ToJsonString());
        Console.Out.Flush();
    }
}

// Arrêt d'urgence : Ctrl+Alt+Fin sur le clavier, quelle que soit la fenêtre au premier plan.
new Thread(() =>
{
    const int VK_CONTROL = 0x11, VK_MENU = 0x12, VK_END = 0x23;
    while (true)
    {
        Thread.Sleep(40);
        bool down(int vk) => (Native.GetAsyncKeyState(vk) & 0x8000) != 0;
        if (!stopped && down(VK_CONTROL) && down(VK_MENU) && down(VK_END))
        {
            stopped = true;
            Send(new JsonObject { ["event"] = "emergency_stop" });
        }
    }
}) { IsBackground = true }.Start();

var keys = new Dictionary<string, VirtualKeyShort>
{
    ["enter"] = VirtualKeyShort.ENTER, ["tab"] = VirtualKeyShort.TAB, ["escape"] = VirtualKeyShort.ESCAPE,
    ["up"] = VirtualKeyShort.UP, ["down"] = VirtualKeyShort.DOWN, ["left"] = VirtualKeyShort.LEFT, ["right"] = VirtualKeyShort.RIGHT,
    ["pageup"] = VirtualKeyShort.PRIOR, ["pagedown"] = VirtualKeyShort.NEXT, ["home"] = VirtualKeyShort.HOME, ["end"] = VirtualKeyShort.END,
};
// Combinaisons : les touches nommées ci-dessus, plus celles-ci, les lettres, les chiffres et F1–F12.
var comboKeys = new Dictionary<string, VirtualKeyShort>(keys)
{
    ["space"] = VirtualKeyShort.SPACE, ["backspace"] = VirtualKeyShort.BACK, ["delete"] = VirtualKeyShort.DELETE, ["insert"] = VirtualKeyShort.INSERT,
};
for (var c = 'a'; c <= 'z'; c++) comboKeys[c.ToString()] = (VirtualKeyShort)((int)VirtualKeyShort.KEY_A + (c - 'a'));
for (var c = '0'; c <= '9'; c++) comboKeys[c.ToString()] = (VirtualKeyShort)((int)VirtualKeyShort.KEY_0 + (c - '0'));
for (var i = 1; i <= 12; i++) comboKeys[$"f{i}"] = (VirtualKeyShort)((int)VirtualKeyShort.F1 + (i - 1));
var modifiers = new Dictionary<string, VirtualKeyShort> { ["ctrl"] = VirtualKeyShort.CONTROL, ["alt"] = VirtualKeyShort.ALT, ["shift"] = VirtualKeyShort.SHIFT };

string ProcessOf(AutomationElement w)
{
    try { return Process.GetProcessById(w.Properties.ProcessId.Value).ProcessName + ".exe"; } catch { return ""; }
}

JsonNode? ListWindows()
{
    var arr = new JsonArray();
    foreach (var w in automation.GetDesktop().FindAllChildren())
    {
        try
        {
            var title = w.Name;
            if (string.IsNullOrEmpty(title)) continue;
            var handle = w.Properties.NativeWindowHandle.ValueOrDefault.ToString();
            if (handle == "0") continue;
            windows[handle] = w.AsWindow();
            var r = w.BoundingRectangle;
            arr.Add(new JsonObject { ["id"] = handle, ["title"] = title, ["process"] = ProcessOf(w), ["rect"] = new JsonObject { ["left"] = r.X, ["top"] = r.Y, ["width"] = r.Width, ["height"] = r.Height } });
        }
        catch { }
    }
    return arr;
}

Window Win(string id)
{
    if (!windows.TryGetValue(id, out var w)) { ListWindows(); windows.TryGetValue(id, out w); }
    return w ?? throw new InvalidOperationException("fenêtre introuvable");
}

JsonNode? Find(JsonObject a)
{
    var w = Win(a["window"]!.GetValue<string>());
    var name = a["name"]?.GetValue<string>();
    var aid = a["automationId"]?.GetValue<string>();
    var ctype = a["controlType"]?.GetValue<string>();
    var wr = w.BoundingRectangle;
    var arr = new JsonArray();
    int i = 0;
    foreach (var e in w.FindAllDescendants())
    {
        var idx = i++;
        try
        {
            var n = e.Name ?? "";
            var id = e.AutomationId ?? "";
            var ct = e.ControlType.ToString();
            if (name is { Length: > 0 } && !n.Contains(name, StringComparison.OrdinalIgnoreCase)) continue;
            if (aid is { Length: > 0 } && aid != id) continue;
            if (ctype is { Length: > 0 } && !string.Equals(ct, ctype, StringComparison.OrdinalIgnoreCase)) continue;
            var eid = $"{(id.Length > 0 ? id : n.Length > 0 ? n : ct)}#{idx}";
            elements[$"{a["window"]!.GetValue<string>()}:{eid}"] = e;
            // Position RELATIVE au coin haut-gauche de la fenêtre : ce qu'attendent mouse_click et mouse_scroll.
            var er = e.BoundingRectangle;
            var rect = new JsonObject { ["x"] = er.X - wr.X, ["y"] = er.Y - wr.Y, ["width"] = er.Width, ["height"] = er.Height };
            arr.Add(new JsonObject { ["id"] = eid, ["name"] = n, ["controlType"] = ct, ["isPassword"] = e.Properties.IsPassword.ValueOrDefault, ["rect"] = rect });
        }
        catch { }
    }
    return arr;
}

AutomationElement El(string win, string eid)
{
    if (!elements.TryGetValue($"{win}:{eid}", out var e)) { Find(new JsonObject { ["window"] = win }); elements.TryGetValue($"{win}:{eid}", out e); }
    return e ?? throw new InvalidOperationException("élément introuvable");
}

// La fenêtre visée passe au premier plan, et on le CONSTATE : sinon, aucune touche n'est envoyée (elle irait à une autre fenêtre).
// Windows refuse souvent qu'un processus d'arrière-plan prenne le premier plan quand la personne travaille dans une autre application (verrou du premier
// plan). Essai 1 : la voie normale (UIA). Essais suivants : on s'attache au fil d'entrée de la fenêtre qui est au premier plan, le temps d'un
// SetForegroundWindow — sans envoyer la moindre touche à l'application de la personne. Si rien n'y fait, on refuse comme avant (rien n'est envoyé).
Window Foreground(string id)
{
    var w = Win(id);
    var target = new IntPtr(long.Parse(id));
    for (var attempt = 0; attempt < 3; attempt++)
    {
        if (attempt == 0) w.Focus(); else Native.ForceForeground(target);
        for (var i = 0; i < 8; i++)
        {
            if (Native.GetAncestor(Native.GetForegroundWindow(), 2) == target) return w;
            Thread.Sleep(50);
        }
    }
    throw new InvalidOperationException("la fenêtre n'a pas pu passer au premier plan : rien n'a été envoyé");
}

// Un point RELATIF à la fenêtre → écran, s'il est dans la fenêtre ET que la fenêtre du dessus à cet endroit est bien elle.
System.Drawing.Point PointIn(string id, JsonObject a)
{
    var w = Foreground(id);
    var r = w.BoundingRectangle;
    var x = a["x"]!.GetValue<int>();
    var y = a["y"]!.GetValue<int>();
    if (x < 0 || y < 0 || x >= r.Width || y >= r.Height) throw new InvalidOperationException($"point ({x}, {y}) hors de la fenêtre ({r.Width} × {r.Height})");
    var p = new System.Drawing.Point(r.X + x, r.Y + y);
    var under = Native.GetAncestor(Native.WindowFromPoint(new Native.POINT { X = p.X, Y = p.Y }), 2);
    if (under != new IntPtr(long.Parse(id))) throw new InvalidOperationException("une autre fenêtre recouvre ce point : rien n'a été cliqué");
    return p;
}

void CheckStopped()
{
    if (stopped) throw new InvalidOperationException("arrêt d'urgence (Ctrl+Alt+Fin) : plus aucune opération");
}

JsonNode? Handle(string op, JsonObject a)
{
    CheckStopped();
    switch (op)
    {
        case "list_windows": return ListWindows();
        case "find_element": return Find(a);
        case "read_text":
        {
            var e = El(a["window"]!.GetValue<string>(), a["element"]!.GetValue<string>());
            if (e.Patterns.Value.IsSupported) return e.Patterns.Value.Pattern.Value.ValueOrDefault ?? "";
            return e.Name ?? "";
        }
        case "click":
        {
            var e = El(a["window"]!.GetValue<string>(), a["element"]!.GetValue<string>());
            if (e.Patterns.Invoke.IsSupported) e.Patterns.Invoke.Pattern.Invoke(); else e.Click();
            return null;
        }
        case "type_text":
        {
            var e = El(a["window"]!.GetValue<string>(), a["element"]!.GetValue<string>());
            var text = a["text"]!.GetValue<string>();
            if (e.Patterns.Value.IsSupported) e.Patterns.Value.Pattern.SetValue(text); else { e.Focus(); Keyboard.Type(text); }
            return null;
        }
        case "focus_window": Foreground(a["window"]!.GetValue<string>()); return null;
        case "press_key":
        {
            var key = a["key"]!.GetValue<string>();
            if (!keys.TryGetValue(key, out var vk)) throw new InvalidOperationException("touche refusée");
            Foreground(a["window"]!.GetValue<string>());
            Keyboard.Type(vk);
            return null;
        }
        case "press_keys":
        {
            var parts = a["combo"]!.GetValue<string>().ToLowerInvariant().Split('+', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length == 0) throw new InvalidOperationException("combinaison vide");
            var seq = new List<VirtualKeyShort>();
            foreach (var m in parts[..^1]) seq.Add(modifiers.TryGetValue(m, out var mv) ? mv : throw new InvalidOperationException($"modificateur refusé : {m}"));
            seq.Add(comboKeys.TryGetValue(parts[^1], out var kv) ? kv : throw new InvalidOperationException($"touche refusée : {parts[^1]}"));
            Foreground(a["window"]!.GetValue<string>());
            Keyboard.TypeSimultaneously(seq.ToArray());
            return null;
        }
        case "type_keys":
        {
            Foreground(a["window"]!.GetValue<string>());
            Keyboard.Type(a["text"]!.GetValue<string>());
            return null;
        }
        case "mouse_click":
        {
            var back = Mouse.Position;
            var p = PointIn(a["window"]!.GetValue<string>(), a);
            var button = a["button"]?.GetValue<string>() ?? "left";
            Mouse.MoveTo(p);
            if (button == "double") Mouse.DoubleClick(p);
            else Mouse.Click(p, button == "right" ? MouseButton.Right : MouseButton.Left);
            Mouse.MoveTo(back);
            // Constaté tout de suite : le curseur est-il revenu ? (l'utilisateur peut bouger sa souris pendant le geste)
            return new JsonObject { ["restored"] = Mouse.Position == back };
        }
        case "mouse_scroll":
        {
            var back = Mouse.Position;
            var p = PointIn(a["window"]!.GetValue<string>(), a);
            Mouse.MoveTo(p);
            Mouse.Scroll(a["amount"]!.GetValue<int>());
            Mouse.MoveTo(back);
            return new JsonObject { ["restored"] = Mouse.Position == back };
        }
        default: throw new InvalidOperationException("opération inconnue");
    }
}

string? line;
while ((line = Console.ReadLine()) != null)
{
    if (string.IsNullOrWhiteSpace(line)) continue;
    JsonNode? id = null;
    JsonObject res;
    try
    {
        var req = JsonNode.Parse(line)!.AsObject();
        id = req["id"]?.DeepClone();
        var result = Handle(req["op"]!.GetValue<string>(), req["args"]?.AsObject() ?? new JsonObject());
        res = new JsonObject { ["id"] = id, ["ok"] = true, ["result"] = result };
    }
    catch (Exception ex)
    {
        var m = ex.Message.Length > 200 ? ex.Message[..200] : ex.Message;
        res = new JsonObject { ["id"] = id, ["ok"] = false, ["error"] = m };
    }
    Send(res);
}

static class Native
{
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint attach, uint to, bool on);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int cmd);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();

    /// <summary>Amène <paramref name="hwnd"/> au premier plan en s'attachant au fil d'entrée du premier plan actuel, puis se détache. N'envoie aucune touche.</summary>
    public static void ForceForeground(IntPtr hwnd)
    {
        if (IsIconic(hwnd)) ShowWindow(hwnd, 9); // SW_RESTORE
        var front = GetForegroundWindow();
        var frontThread = front == IntPtr.Zero ? 0u : GetWindowThreadProcessId(front, out _);
        var me = GetCurrentThreadId();
        var attached = frontThread != 0 && frontThread != me && AttachThreadInput(me, frontThread, true);
        try { BringWindowToTop(hwnd); SetForegroundWindow(hwnd); }
        finally { if (attached) AttachThreadInput(me, frontThread, false); }
    }
}
