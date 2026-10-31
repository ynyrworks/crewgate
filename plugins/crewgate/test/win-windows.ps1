# Test helper. Writes every console or terminal window that becomes visible, from now until -StopFile exists, to -Out.
# Same scan as a window watcher built on EnumWindows: ConsoleWindowClass, CASCADIA_HOSTING_WINDOW_CLASS, PseudoConsoleWindow.
param([string]$StopFile, [string]$ReadyFile, [string]$Out)
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class W {
  delegate bool Cb(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(Cb c, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  public static List<string> Scan() {
    var r = new List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var c = new StringBuilder(128); GetClassName(h, c, 128);
      var k = c.ToString();
      if (k == "ConsoleWindowClass" || k == "CASCADIA_HOSTING_WINDOW_CLASS" || k == "PseudoConsoleWindow") r.Add(h.ToInt64() + "|" + k);
      return true;
    }, IntPtr.Zero);
    return r;
  }
}
'@
$seen = @{}; foreach ($x in [W]::Scan()) { $seen[$x] = $true }
$new = @()
Set-Content -LiteralPath $ReadyFile -Value 'ready'
while (-not (Test-Path -LiteralPath $StopFile)) {
  foreach ($x in [W]::Scan()) { if (-not $seen.ContainsKey($x)) { $seen[$x] = $true; $new += $x } }
  Start-Sleep -Milliseconds 10
}
foreach ($x in [W]::Scan()) { if (-not $seen.ContainsKey($x)) { $seen[$x] = $true; $new += $x } }
Set-Content -LiteralPath $Out -Value ($new -join "`n")
