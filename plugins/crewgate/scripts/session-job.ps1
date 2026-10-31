# Holder for one Claude Code session on Windows: one unnamed Job Object, a CPU hard cap, cleanup at exit.
# Started hidden (through a detached cmd) by lib/hooks/sessionjob.js. It is not in the job itself. No kill-on-close and no
# TerminateJobObject: if this process dies first, the session and its children simply carry on.
param(
  [int]$ClaudePid, [string]$ProjectId, [string]$PidFile, [string]$CrewHome, [string]$NodeExe, [string]$RecordScript,
  [int]$CapPercent = 60, [string]$Cleanup = 'on', [int64]$HookStart = 0, [string]$TestKeepFile = ''
)
$ErrorActionPreference = 'Stop'

function Record([string]$type, [string[]]$kv) {
  try { & $NodeExe $RecordScript --record $ProjectId $type @kv | Out-Null } catch { }
}

function Done {
  try { if ((Get-Content -LiteralPath $PidFile -Raw -ErrorAction Stop).Trim() -eq "$PID") { Remove-Item -LiteralPath $PidFile -ErrorAction SilentlyContinue } } catch { }
  exit 0
}

# What cleanup must leave alone. $procs: pid -> @{ ppid; window; boardlike }. Roots are the running board (by pid), every
# process with a visible main window (a browser or any program the user can see) and, when there is no usable board pid,
# a process whose command line is this plugin's `board serve`. A root's descendants are kept too. -> hashtable of pids
function Get-Keep($procs, [int]$boardPid) {
  $keep = @{}
  $queue = New-Object System.Collections.Queue
  foreach ($k in $procs.Keys) {
    $p = $procs[$k]
    if (($boardPid -gt 0 -and [int]$k -eq $boardPid) -or $p.window -or $p.boardlike) { $keep[[int]$k] = $true; $queue.Enqueue([int]$k) }
  }
  $kids = @{}
  foreach ($k in $procs.Keys) { $pp = [int]$procs[$k].ppid; if (-not $kids.ContainsKey($pp)) { $kids[$pp] = @() }; $kids[$pp] += [int]$k }
  while ($queue.Count -gt 0) {
    $x = $queue.Dequeue()
    if ($kids.ContainsKey($x)) { foreach ($c in $kids[$x]) { if (-not $keep.ContainsKey($c)) { $keep[$c] = $true; $queue.Enqueue($c) } } }
  }
  return $keep
}

# Test entry: -TestKeepFile <json {board, procs:[{pid,ppid,window,boardlike}]}> prints the kept pids and stops.
if ($TestKeepFile) {
  $t = Get-Content -LiteralPath $TestKeepFile -Raw | ConvertFrom-Json
  $m = @{}
  foreach ($x in $t.procs) { $m[[int]$x.pid] = @{ ppid = [int]$x.ppid; window = [bool]$x.window; boardlike = [bool]$x.boardlike } }
  $k = Get-Keep $m ([int]$t.board)
  ConvertTo-Json -InputObject @($k.Keys | Sort-Object) -Compress
  exit 0
}

# The board named in board.json. -> @{ mode = 'pid' | 'absent' | 'dead' | 'bad'; pid }.
# absent / dead: no usable pid (board.js removes the file of a live board after a missed health check), so the command
# line is used instead. bad: the file exists but cannot be read or has no valid pid, so cleanup stops nothing.
function Get-Board($all) {
  $f = Join-Path $CrewHome 'board.json'
  if (-not (Test-Path -LiteralPath $f)) { return @{ mode = 'absent'; pid = 0 } }
  try {
    $bj = Get-Content -LiteralPath $f -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    $bp = [int]$bj.pid
  } catch { return @{ mode = 'bad'; pid = 0 } }
  if ($bp -le 0) { return @{ mode = 'bad'; pid = 0 } }
  if (-not $all.ContainsKey($bp)) { return @{ mode = 'dead'; pid = 0 } }
  return @{ mode = 'pid'; pid = $bp }
}

try {
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
} catch { Record 'session.job.error' @('reason=add-type-failed'); Done }

$self = $PID
try { Set-Content -LiteralPath $PidFile -Value "$self" } catch { }
try {
  $session = [System.Diagnostics.Process]::GetProcessById($ClaudePid)
  $null = $session.Handle
} catch { Record 'session.job.error' @('reason=session-gone'); Done }
# The pid was taken a moment ago by the hook: a process that started after that is not the Claude Code process.
if ($HookStart -gt 0 -and $session.StartTime.ToUniversalTime() -gt [DateTimeOffset]::FromUnixTimeMilliseconds($HookStart).UtcDateTime) {
  Record 'session.job.error' @('reason=pid-reused'); Done
}

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

  $foundSet = @{}; $keptSet = @{}; $stoppedSet = @{}; $err = ''
  # A leftover may start a child while we work, so list and stop again, a few rounds at most, until only kept ones remain.
  for ($round = 0; $round -lt 5; $round++) {
    $ids = [CG.J]::List($job)
    if ($null -eq $ids) { $err = 'list-failed'; break }
    $all = @{}
    try {
      foreach ($r in (Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, CommandLine -ErrorAction Stop)) {
        $all[[int]$r.ProcessId] = @{ ppid = [int]$r.ParentProcessId; cmd = [string]$r.CommandLine }
      }
    } catch { $err = 'tree-unreadable'; break }
    $b = Get-Board $all
    if ($b.mode -eq 'bad') { $err = 'board-json-unreadable'; break }
    $procs = @{}
    foreach ($k in $all.Keys) {
      # Another session's holder is kept too: it exits by itself with its session, and cleans up that session's job.
      $procs[$k] = @{ ppid = $all[$k].ppid; window = $false; boardlike = ($all[$k].cmd -match '[\\/]crew\.js"?\s+board\s+serve|[\\/]session-job\.ps1') }
    }
    $mine = @()
    foreach ($id in $ids) {
      $id = [int]$id
      if ($id -eq $self -or $id -eq $ClaudePid) { continue }
      $mine += $id
      try {
        $pr = Get-Process -Id $id -ErrorAction Stop
        if ($pr.MainWindowHandle -ne [IntPtr]::Zero -and $procs.ContainsKey($id)) { $procs[$id].window = $true }
      } catch { }
    }
    $keep = Get-Keep $procs $b.pid
    $todo = @()
    foreach ($id in $mine) {
      $foundSet[$id] = $true
      if ($keep.ContainsKey($id)) { $keptSet[$id] = $true }
      # kept in any earlier round stays kept (a window can close, or not be up yet)
      if ($keptSet.ContainsKey($id)) { continue }
      if (-not $stoppedSet.ContainsKey($id)) { $todo += $id }
    }
    if ($todo.Count -eq 0 -or $Cleanup -ne 'on') { break }
    foreach ($id in $todo) {
      try {
        $p = [System.Diagnostics.Process]::GetProcessById($id)
        $in = $false
        # Only a process that is still in this job: a reused pid is not.
        if ([CG.J]::IsProcessInJob($p.Handle, $job, [ref]$in) -and $in) { $p.Kill(); $stoppedSet[$id] = $true }
      } catch { }
    }
    Start-Sleep -Milliseconds 300
  }
  $extra = @("found=$($foundSet.Count)", "stopped=$($stoppedSet.Count)", "kept=$($keptSet.Count)", "cleanup=$Cleanup")
  if ($err) { $extra += "error=$err" }
  Record 'session.cleanup' $extra
} finally { Done }
