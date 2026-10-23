# Tient Ctrl+Alt+Fin 300 ms (comme un doigt humain) pour éprouver l'arrêt d'urgence du moteur FlaUI. Le test ne l'appelle qu'avec sa fenêtre
# FABRIQUÉE au premier plan : les touches vont à cette fenêtre (sans effet dans un champ de texte).
Add-Type -Namespace J -Name K -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);'
$keys = 0x11, 0x12, 0x23
foreach ($k in $keys) { [J.K]::keybd_event($k, 0, 0, [System.UIntPtr]::Zero) }
Start-Sleep -Milliseconds 300
[array]::Reverse($keys)
foreach ($k in $keys) { [J.K]::keybd_event($k, 0, 2, [System.UIntPtr]::Zero) }
