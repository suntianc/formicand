using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;

// Windows CreateProcess cannot execute a shebang. Forward each original
// argument to the sibling fixture script using the Windows argv quoting rules.
class ShellCommand {
    static string Quote(string value) {
        var escaped = Regex.Replace(value, "(\\\\*)\"", m =>
            new string('\\', 2 * m.Groups[1].Length + 1) + "\"");
        return "\"" + Regex.Replace(escaped, @"\\+\z", m => m.Value + m.Value) + "\"";
    }

    static int Main(string[] args) {
        var path = Assembly.GetExecutingAssembly().Location;
        var script = Path.ChangeExtension(path, ".sh").Replace('\\', '/');
        var start = new ProcessStartInfo(File.ReadAllText(Path.ChangeExtension(path, ".shell")),
            String.Join(" ", new[] { script }.Concat(args).Select(Quote)));
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        // Explicit redirection makes .NET pass STARTF_USESTDHANDLES for all three
        // streams even when there is no console. Preserve the raw diagnostic bytes.
        start.RedirectStandardError = true;
        using (var child = Process.Start(start)) {
            child.StandardError.BaseStream.CopyTo(Console.OpenStandardError());
            child.WaitForExit();
            return child.ExitCode;
        }
    }
}
