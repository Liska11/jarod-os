# Fenêtre cible FABRIQUÉE pour les tests UI Automation : un champ, un champ protégé, un bouton, une étiquette.
param([string]$Title = 'JarodUiaTarget')
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.Form
$f.Text = $Title; $f.StartPosition = 'Manual'; $f.Location = New-Object System.Drawing.Point(200, 200); $f.Width = 360; $f.Height = 240
$t = New-Object System.Windows.Forms.TextBox; $t.Name = 'saisie'; $t.AccessibleName = 'saisie'; $t.Left = 10; $t.Top = 10; $t.Width = 200
$p = New-Object System.Windows.Forms.TextBox; $p.Name = 'protege'; $p.AccessibleName = 'protege'; $p.UseSystemPasswordChar = $true; $p.Left = 10; $p.Top = 40; $p.Width = 200
$l = New-Object System.Windows.Forms.Label; $l.Name = 'resultat'; $l.Text = 'vide'; $l.Left = 10; $l.Top = 100; $l.Width = 300
$b = New-Object System.Windows.Forms.Button; $b.Name = 'valider'; $b.Text = 'Valider'; $b.Left = 10; $b.Top = 70
$b.Add_Click({ $l.Text = 'OK:' + $t.Text })
$f.Controls.AddRange(@($t, $p, $l, $b))
$timer = New-Object System.Windows.Forms.Timer; $timer.Interval = 40000; $timer.Add_Tick({ $f.Close() }); $timer.Start()
[void]$f.ShowDialog()
