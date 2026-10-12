// Faux « adb » des tests (SPECS-P5-UI-PARITE.md § 21), jamais livré : à chaque lancement il AJOUTE une ligne (les arguments séparés par U+001F) au fichier nommé par
// FAKE_ADB_LOG, puis répond comme un adb sans appareil. Compilé par le test avec le compilateur .NET fourni par Windows.
using System;
using System.IO;

class FakeAdb
{
    static int Main(string[] args)
    {
        string log = Environment.GetEnvironmentVariable("FAKE_ADB_LOG");
        if (!string.IsNullOrEmpty(log)) File.AppendAllText(log, string.Join("\u001f", args) + "\n");
        Console.Write("List of devices attached\r\n");
        return 0;
    }
}
