[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('ConfirmIsolation','ConfirmOldDisabled','ConfirmOldDrained','Snapshot','ConfirmFirstRun','Enable','Rollback')]
    [string]$Stage,
    [switch]$Confirmed,
    [string]$NodePath = 'C:\Program Files\nodejs\node.exe',
    [string]$ProfilePath,
    [switch]$ApproveLegacyAutomation
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $root 'state'
$logDir = Join-Path $root 'logs'
$runnerArgs = @()
if ($ProfilePath) {
    $ProfilePath = (Resolve-Path -LiteralPath $ProfilePath).Path
    $profileRunner = Join-Path $ProfilePath 'gmail-ingest'
    if ((Get-Item -LiteralPath $ProfilePath).Attributes -band [IO.FileAttributes]::ReparsePoint -or
        (Get-Item -LiteralPath $profileRunner).Attributes -band [IO.FileAttributes]::ReparsePoint -or
        [IO.Path]::GetFullPath($profileRunner) -eq $root) { throw 'The profile must be isolated.' }
    $stateDir = Join-Path $profileRunner 'state'
    $logDir = Join-Path $profileRunner 'logs'
    foreach ($folder in @($stateDir, $logDir)) {
        if ((Test-Path -LiteralPath $folder) -and ((Get-Item -LiteralPath $folder).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'The profile state and logs must be isolated.'
        }
    }
    $runnerArgs = @('--profile', $ProfilePath)
}
$ledger = Join-Path $stateDir 'cutover.json'
$previous = if (Test-Path -LiteralPath $ledger) { Get-Content -LiteralPath $ledger -Raw | ConvertFrom-Json }
$taskName = if ($ProfilePath) { 'GmailIngest-Weekly-Test' } else { 'GmailIngest-Weekly' }

function Assert-ExpectedStage([string]$Expected) {
    $current = if ($previous) { $previous.stage } else { '' }
    if ($current -ne $Expected) { throw "Cutover is at '$current'. Expected '$Expected'." }
}
function Assert-TaskDisabled {
    $task = Get-ScheduledTask -TaskPath '\my-app2\' -ErrorAction Stop | Where-Object TaskName -eq $taskName
    if ($task -and $task.State -ne 'Disabled') { throw 'The new scheduled task must be disabled during cutover.' }
}
function Save-Stage([string]$Next, [string]$Generation = '') {
    [IO.Directory]::CreateDirectory($stateDir) | Out-Null
    $temporary = "$ledger.$([guid]::NewGuid()).tmp"
    $backup = "$temporary.bak"
    $record = @{ stage=$Next; at=[datetime]::UtcNow.ToString('o'); generation=$Generation }
    try {
        [IO.File]::WriteAllText($temporary, ($record | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
        if (Test-Path -LiteralPath $ledger) { [IO.File]::Replace($temporary, $ledger, $backup) }
        else { [IO.File]::Move($temporary, $ledger) }
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary }
        if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup }
    }
    [pscustomobject]$record
}
if (-not $Confirmed) { throw 'Review the documented evidence for this stage and pass -Confirmed.' }

switch ($Stage) {
    'ConfirmIsolation' { Assert-ExpectedStage ''; Assert-TaskDisabled; Save-Stage 'isolation-verified' }
    'ConfirmOldDisabled' { Assert-ExpectedStage 'isolation-verified'; Assert-TaskDisabled; Save-Stage 'old-disabled' }
    'ConfirmOldDrained' { Assert-ExpectedStage 'old-disabled'; Assert-TaskDisabled; Save-Stage 'old-drained' }
    'Snapshot' {
        Assert-ExpectedStage 'old-drained'
        Assert-TaskDisabled
        $snapshotArgs = @($runnerArgs) + '--restore-set'
        if (-not $ProfilePath) { $snapshotArgs += '--include-legacy-state' }
        $result = & $NodePath (Join-Path $root 'run.mjs') @snapshotArgs | ConvertFrom-Json
        if ($LASTEXITCODE -ne 0 -or -not $result.data.generation) { throw "A verified restore set was not created (runner exit $LASTEXITCODE)." }
        Save-Stage 'snapshot-verified' $result.data.generation
    }
    'ConfirmFirstRun' {
        Assert-ExpectedStage 'snapshot-verified'
        Assert-TaskDisabled
        $summary = Get-Content -LiteralPath (Join-Path $logDir 'summary.json') -Raw | ConvertFrom-Json
        $successes = @($summary.entries | Where-Object { $_.step -eq 'verify' -and $_.outcome -eq 'success' } | ForEach-Object { $_.provider } | Select-Object -Unique)
        $required = @('type_a','type_b','smbc','rakuten_card','jcb_ekenet')
        if ($summary.exit_code -ne 0 -or [datetimeoffset]$summary.started_at -lt [datetimeoffset]$previous.at -or
            @($required | Where-Object { $_ -notin $successes }).Count -ne 0) {
            throw 'The latest run does not prove a successful post-snapshot import for all targets.'
        }
        Save-Stage 'first-run-verified' $previous.generation
    }
    'Enable' {
        Assert-ExpectedStage 'first-run-verified'
        & (Join-Path $PSScriptRoot 'register-task.ps1') -NodePath $NodePath -ProfilePath $ProfilePath
        Save-Stage 'enabled' $previous.generation
    }
    'Rollback' {
        & (Join-Path $PSScriptRoot 'unregister-task.ps1') -TestTask:([bool]$ProfilePath)
        $jst = [datetimeoffset]::UtcNow.ToOffset([timespan]::FromHours(9))
        $permitted = $ApproveLegacyAutomation -and $jst.Date -lt [datetime]'2027-02-01'
        Save-Stage 'new-disabled' $previous.generation
        [pscustomobject]@{ legacy_reenable_permitted = [bool]$permitted }
    }
}
