# Holder for one Claude Code session on Windows: one unnamed Job Object, a CPU hard cap, cleanup at exit.
# Started detached and hidden by lib/hooks/sessionjob.js. It is not in the job itself. No kill-on-close and no
# TerminateJobObject: if this process dies first, the session and its children simply carry on.
param(
  [int]$ClaudePid, [string]$ProjectId, [string]$PidFile, [string]$CrewHome, [string]$NodeExe, [string]$RecordScript,
  [int]$CapPercent = 60, [string]$Cleanup = 'on'
)
$ErrorActionPreference = 'Stop'

function Record([string]$type, [string[]]$kv) {
  try { & $NodeExe $RecordScript --record $ProjectId $type @kv | Out-Null } catch { }
}

function Done {
  try { if ((Get-Content -LiteralPath $PidFile -Raw -ErrorAction Stop).Trim() -eq "$PID") { Remove-Item -LiteralPath $PidFile -ErrorAction SilentlyContinue } } catch { }
  exit 0
}

Add-Type -Namespace CG -Name J -MemberDefinition @'
[DllImport("kernel32.dll",SetLastError=true)] public static extern IntPtr CreateJobObject(IntPtr a,IntPtr n);
[DllImport("kernel32.dll",SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr j,IntPtr p);
[DllImport("kernel32.dll",SetLastError=true)] public static extern bool IsProcessInJob(IntPtr p,IntPtr j,out bool r);
[DllImport("kernel32.dll",SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr j,int c,IntPtr i,int s);
[DllImport("kernel32.dll",SetLastError=true)] public static extern bool QueryInformationJobObject(IntPtr j,int c,IntPtr i,int s,IntPtr ret);
public static bool SetCap(IntPtr job, uint hundredths) {
  IntPtr p = Marshal.AllocHGlobal(8);
  try { Marshal.WriteInt32(p, 0, 5); Marshal.WriteInt32(p, 4, (int)hundredths); return SetInformationJobObject(job, 15, p, 8); }
  finally { Marshal.FreeHGlobal(p); }
}
// -1 = could not read; 0 = no cap enabled; else hundredths of a percent
public static int GetCap(IntPtr job) {
  IntPtr p = Marshal.AllocHGlobal(8);
  try {
    if (!QueryInformationJobObject(job, 15, p, 8, IntPtr.Zero)) return -1;
    int flags = Marshal.ReadInt32(p, 0);
    return ((flags & 1) != 0 && (flags & 4) != 0) ? Marshal.ReadInt32(p, 4) : 0;
  } finally { Marshal.FreeHGlobal(p); }
}
// JobObjectBasicProcessIdList (class 3); null when it cannot be read
public static long[] List(IntPtr job) {
  int n = 4096, sz = IntPtr.Size, size = 8 + sz * n;
  IntPtr p = Marshal.AllocHGlobal(size);
  try {
    if (!QueryInformationJobObject(job, 3, p, size, IntPtr.Zero)) return null;
    int got = Marshal.ReadInt32(p, 4);
    long[] r = new long[got];
    for (int i = 0; i < got; i++) r[i] = sz == 8 ? Marshal.ReadInt64(p, 8 + 8 * i) : Marshal.ReadInt32(p, 8 + 4 * i);
    return r;
  } finally { Marshal.FreeHGlobal(p); }
}
'@

$self = $PID
try { Set-Content -LiteralPath $PidFile -Value "$self" } catch { }
try {
  $session = [System.Diagnostics.Process]::GetProcessById($ClaudePid)
  $null = $session.Handle
} catch { Record 'session.job.error' @('reason=session-gone'); Done }

try {
  $job = [CG.J]::CreateJobObject([IntPtr]::Zero, [IntPtr]::Zero)
  if ($job -eq [IntPtr]::Zero) { throw 'create' }
  if ($CapPercent -lt 100) { if (-not [CG.J]::SetCap($job, [uint32]($CapPercent * 100))) { Record 'session.job.error' @('reason=cap-refused'); } }
  $read = [CG.J]::GetCap($job)
  if (-not [CG.J]::AssignProcessToJobObject($job, $session.Handle)) {
    $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    Record 'session.job.error' @('reason=assign-refused', "win32=$code")
    Done
  }
  $capRead = if ($read -gt 0) { [int]($read / 100) } elseif ($read -eq 0) { 100 } else { -1 }
  Record 'session.job' @("assigned=true", "cap_wanted=$CapPercent", "cap_read=$capRead", "cleanup=$Cleanup", "holder=$self")
} catch { Record 'session.job.error' @('reason=setup-failed'); Done }

try {
  # Blocks on the process handle: no polling, no CPU.
  $session.WaitForExit()

  $ids = [CG.J]::List($job)
  if ($null -eq $ids) { Record 'session.cleanup' @('error=list-failed', 'stopped=0'); Done }

  # The running board, and everything it started, is left alone.
  $skip = @{}
  $skipOk = $true
  try {
    $bj = Get-Content -LiteralPath (Join-Path $CrewHome 'board.json') -Raw -ErrorAction Stop | ConvertFrom-Json
    $bp = [int]$bj.pid
    if ($bp -gt 0 -and (Get-Process -Id $bp -ErrorAction SilentlyContinue)) {
      $skip[$bp] = $true
      try {
        $all = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId -ErrorAction Stop
        $kids = @{}
        foreach ($r in $all) { $pp = [int]$r.ParentProcessId; if (-not $kids.ContainsKey($pp)) { $kids[$pp] = @() }; $kids[$pp] += [int]$r.ProcessId }
        $queue = New-Object System.Collections.Queue; $queue.Enqueue($bp)
        while ($queue.Count -gt 0) {
          $x = $queue.Dequeue()
          if ($kids.ContainsKey($x)) { foreach ($c in $kids[$x]) { if (-not $skip.ContainsKey($c)) { $skip[$c] = $true; $queue.Enqueue($c) } } }
        }
      } catch { $skipOk = $false }
    }
  } catch { }

  $found = 0; $stopped = 0; $kept = 0
  foreach ($id in $ids) {
    $id = [int]$id
    if ($id -eq $self -or $id -eq $ClaudePid) { continue }
    $found++
    if ($skip.ContainsKey($id)) { $kept++; continue }
    if ($Cleanup -ne 'on' -or -not $skipOk) { continue }
    try {
      $p = [System.Diagnostics.Process]::GetProcessById($id)
      $in = $false
      # Only a process that is still in this job: a reused pid is not.
      if ([CG.J]::IsProcessInJob($p.Handle, $job, [ref]$in) -and $in) { $p.Kill(); $stopped++ }
    } catch { }
  }
  $extra = @("found=$found", "stopped=$stopped", "kept=$kept", "cleanup=$Cleanup")
  if (-not $skipOk) { $extra += 'error=tree-unreadable' }
  Record 'session.cleanup' $extra
} finally { Done }
