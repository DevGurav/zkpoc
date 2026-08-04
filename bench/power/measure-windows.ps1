<#
.SYNOPSIS
  Measure marginal power draw of a browser compute load, on Windows, with no
  extra software installed.

.DESCRIPTION
  watts_full is the single least defensible number in the break-even model and
  the one thing bench/device/probe.html cannot obtain -- browsers expose no
  power API at all. Windows does: while running on battery, the ACPI battery
  reports both an instantaneous discharge rate and a RemainingCapacity energy
  counter in mWh through WMI (root\wmi BatteryStatus). Both are logged; the
  analysis uses the energy counter, because firmware refreshes the rate only
  every few seconds and 1 Hz sampling of it yields long runs of duplicates.

  Four phases. The baseline is measured either side of the load so drift is
  visible rather than silently folded into the result:

    0. settle  -- wait until the idle baseline stops moving
    1. idle    -- establish the baseline
    2. load    -- you start a sustained run in the browser
    3. idle    -- confirm the baseline returned

  Phase 0 exists because it is the failure mode that actually bites. A laptop
  touched a minute ago keeps winding down: background indexing finishing, cores
  dropping to low P-states, the panel auto-dimming on battery. Drift of 15-20 W
  across three minutes is routine, and the GPU signal being measured is smaller
  than that, so without settling the result is dominated by the decay and can
  even come out negative.

.PARAMETER SettleSeconds
  Maximum wait for the baseline to stabilise before measuring. Detection
  compares two consecutive 30 s energy windows and proceeds when they agree
  within 10%. Default 150. Set to 0 to skip.

.PARAMETER IdleSeconds
  Length of each idle phase. Default 30.

.PARAMETER LoadSeconds
  Length of the load phase. MUST match your probe's sustained duration -- if
  the probe stops early the remainder is idle and drags the average down.
  Default 60.

.PARAMETER Out
  CSV path. Default bench/power/power-log.csv

.EXAMPLE
  .\measure-windows.ps1 -LoadSeconds 120
  Then analyse with:  python bench/power/analyse_power.py

.NOTES
  MUST be on battery. A charging laptop reports a charge rate, not a discharge
  rate, and the measurement is meaningless -- the script refuses to continue.
  Close other applications first; this measures the whole machine, so anything
  else that wakes up lands in the result.

  Read-only: samples a WMI counter and writes one CSV. Changes nothing.
#>

[CmdletBinding()]
param(
  [int]$IdleSeconds = 30,
  [int]$LoadSeconds = 60,
  # Wait for the baseline to stop moving before measuring anything. A laptop
  # that was touched recently keeps winding down for minutes -- background
  # indexing finishing, cores dropping to low P-states, the panel auto-dimming
  # on battery. Observed drift of 15-20 W is routine, which is larger than the
  # entire signal being measured, and it silently poisons the result.
  [int]$SettleSeconds = 150,
  # Resolved in the body, not here: $PSScriptRoot is not reliably populated
  # while param defaults are bound, and an empty value silently becomes
  # "\power-log.csv" -- i.e. the root of the current drive, which is denied.
  [string]$Out
)

$ErrorActionPreference = 'Stop'

if (-not $Out) {
  $root = $PSScriptRoot
  if (-not $root -and $MyInvocation.MyCommand.Path) {
    $root = Split-Path -Parent $MyInvocation.MyCommand.Path
  }
  if (-not $root) { $root = (Get-Location).Path }
  $Out = Join-Path $root 'power-log.csv'
}

function Get-BatterySample {
  try {
    $b = Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus -ErrorAction Stop |
         Select-Object -First 1
  } catch {
    return $null
  }
  if ($null -eq $b) { return $null }
  [pscustomobject]@{
    DischargeRate    = [int]$b.DischargeRate     # mW, 0 while charging
    ChargeRate       = [int]$b.ChargeRate
    RemainingCapacity= [int]$b.RemainingCapacity # mWh
    Voltage          = [int]$b.Voltage           # mV
    Charging         = [bool]$b.Charging
    PowerOnline      = [bool]$b.PowerOnline
  }
}

$probe = Get-BatterySample
if ($null -eq $probe) {
  Write-Error "No battery data from root\wmi BatteryStatus. Desktop, VM, or an unsupported ACPI implementation -- this method will not work here. Use Intel Power Gadget or an external meter instead."
  exit 1
}
if ($probe.Charging -or $probe.PowerOnline) {
  Write-Error "The machine is plugged in. DischargeRate reads 0 while charging, so unplug the charger and run again."
  exit 1
}
if ($probe.DischargeRate -le 0) {
  Write-Error "DischargeRate reported as $($probe.DischargeRate) mW. This firmware does not populate the counter; use Intel Power Gadget or HWiNFO instead."
  exit 1
}

# Prove the log is writable BEFORE spending three minutes collecting data.
# The previous version discovered this only on the first write and then kept
# running, burning the whole measurement window to produce nothing.
try {
  "phase,elapsed_s,discharge_mw,remaining_mwh,voltage_mv" |
    Out-File -Encoding utf8 -FilePath $Out -ErrorAction Stop
} catch {
  Write-Error "Cannot write to '$Out': $($_.Exception.Message)`nPass a writable path with -Out, e.g. -Out `"$env:TEMP\power-log.csv`""
  exit 1
}

$total = ($IdleSeconds * 2) + $LoadSeconds + $SettleSeconds
Write-Host ""
Write-Host "ZK-PoC power measurement -- $total s total" -ForegroundColor Cyan
Write-Host "Logging to: $Out"
Write-Host "Baseline draw right now: $($probe.DischargeRate) mW"
Write-Host ""

# ---------------------------------------------------------------- settle
# Uses the mWh energy counter rather than DischargeRate: firmware refreshes the
# instantaneous rate only every few seconds, so it is far too noisy to detect
# stability. Integrated energy over a trailing window is smooth enough to tell
# a settling machine from a settled one.
if ($SettleSeconds -gt 0) {
  Write-Host "PHASE 0/4  settling -- leave the machine completely alone" -ForegroundColor Yellow
  Write-Host "  (waiting for the idle baseline to stop moving; up to $SettleSeconds s)" -ForegroundColor DarkGray

  $hist = New-Object System.Collections.Generic.List[object]
  $settleStart = Get-Date
  $settled = $false
  $lastPower = 0

  while (((Get-Date) - $settleStart).TotalSeconds -lt $SettleSeconds) {
    $s = Get-BatterySample
    if ($null -ne $s) {
      $hist.Add([pscustomobject]@{
        t   = ((Get-Date) - $settleStart).TotalSeconds
        mwh = $s.RemainingCapacity
      })
    }
    if ($hist.Count -ge 60) {
      $n = $hist.Count
      $a = $hist[$n - 60]; $b = $hist[$n - 30]; $c = $hist[$n - 1]
      $h1 = ($b.t - $a.t) / 3600.0
      $h2 = ($c.t - $b.t) / 3600.0
      if ($h1 -gt 0 -and $h2 -gt 0) {
        $p1 = ($a.mwh - $b.mwh) / $h1
        $p2 = ($b.mwh - $c.mwh) / $h2
        if ($p2 -gt 0) {
          $lastPower = $p2
          $delta = [math]::Abs($p1 - $p2) / $p2
          $left = [math]::Round($SettleSeconds - ((Get-Date) - $settleStart).TotalSeconds)
          Write-Host -NoNewline ("`r  {0:N0} mW   window-to-window drift {1:N0}%   {2}s left    " -f $p2, ($delta * 100), $left)
          if ($delta -lt 0.10) { $settled = $true; break }
        }
      }
    } else {
      Write-Host -NoNewline "`r  building history $($hist.Count)/60 s    "
    }
    Start-Sleep -Milliseconds 1000
  }

  Write-Host ""
  if ($settled) {
    Write-Host ("  settled at ~{0:N0} mW" -f $lastPower) -ForegroundColor Green
  } else {
    Write-Host "  ! did not settle within $SettleSeconds s. Continuing anyway, but" -ForegroundColor Yellow
    Write-Host "    expect the analysis to report a drifting baseline and refuse" -ForegroundColor Yellow
    Write-Host "    to give a single figure. Close background apps and retry." -ForegroundColor Yellow
  }
}

$start = Get-Date
$phases = @(
  @{ Name = 'idle_pre';  Seconds = $IdleSeconds; Message = 'PHASE 1/4  idle baseline -- do not touch the machine' },
  @{ Name = 'load';      Seconds = $LoadSeconds; Message = "PHASE 2/4  START THE SUSTAINED PROBE RUN NOW (set it to $LoadSeconds s)" },
  @{ Name = 'idle_post'; Seconds = $IdleSeconds; Message = 'PHASE 3/4  idle again -- stop the probe' }
)

foreach ($phase in $phases) {
  Write-Host ""
  Write-Host $phase.Message -ForegroundColor Yellow
  $phaseStart = Get-Date
  # Buffer the phase in memory and flush once at its end: three file writes
  # instead of 180, and nothing to fail mid-sample.
  $rows = New-Object System.Collections.Generic.List[string]
  while (((Get-Date) - $phaseStart).TotalSeconds -lt $phase.Seconds) {
    $s = Get-BatterySample
    if ($null -ne $s) {
      $elapsed = [math]::Round(((Get-Date) - $start).TotalSeconds, 2)
      $rows.Add("$($phase.Name),$elapsed,$($s.DischargeRate),$($s.RemainingCapacity),$($s.Voltage)")
      $remain = [math]::Round($phase.Seconds - ((Get-Date) - $phaseStart).TotalSeconds)
      Write-Host -NoNewline "`r  $($s.DischargeRate) mW    ${remain}s remaining    "
    }
    Start-Sleep -Milliseconds 1000
  }
  Add-Content -Encoding utf8 -Path $Out -Value $rows
  Write-Host ""
  Write-Host "  logged $($rows.Count) samples" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "Wrote $Out" -ForegroundColor Green
Write-Host "Now run:  python bench/power/analyse_power.py"
Write-Host ""
