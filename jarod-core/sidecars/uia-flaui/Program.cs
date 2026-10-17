// Sidecar UI Automation (FlaUI, UIA3) : mêmes sept opérations et même protocole que le sidecar pywinauto.
// Une ligne JSON par requête sur stdin {"id","op","args"}, une ligne JSON par réponse sur stdout {"id","ok","result"|"error"}.
// La politique (fenêtres permises, accord, débit) est appliquée par l'hôte AVANT l'envoi ; ce processus n'exécute que ces sept opérations.
using System.Diagnostics;
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

var keys = new Dictionary<string, VirtualKeyShort>
{
    ["enter"] = VirtualKeyShort.ENTER, ["tab"] = VirtualKeyShort.TAB, ["escape"] = VirtualKeyShort.ESCAPE,
    ["up"] = VirtualKeyShort.UP, ["down"] = VirtualKeyShort.DOWN, ["left"] = VirtualKeyShort.LEFT, ["right"] = VirtualKeyShort.RIGHT,
    ["pageup"] = VirtualKeyShort.PRIOR, ["pagedown"] = VirtualKeyShort.NEXT, ["home"] = VirtualKeyShort.HOME, ["end"] = VirtualKeyShort.END,
};

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
            arr.Add(new JsonObject { ["id"] = handle, ["title"] = title, ["process"] = ProcessOf(w) });
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
            arr.Add(new JsonObject { ["id"] = eid, ["name"] = n, ["controlType"] = ct, ["isPassword"] = e.Properties.IsPassword.ValueOrDefault });
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

JsonNode? Handle(string op, JsonObject a)
{
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
        case "focus_window": Win(a["window"]!.GetValue<string>()).Focus(); return null;
        case "press_key":
        {
            var key = a["key"]!.GetValue<string>();
            if (!keys.TryGetValue(key, out var vk)) throw new InvalidOperationException("touche refusée");
            Win(a["window"]!.GetValue<string>()).Focus();
            Keyboard.Type(vk);
            return null;
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
    Console.WriteLine(res.ToJsonString());
    Console.Out.Flush();
}
