[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$NodePath = 'C:\Program Files\nodejs\node.exe',
    [string]$StartBoundary = '2026-11-30T08:00:00+09:00',
    [switch]$XmlOnly
)
# 週次実行の読み取り専用診断を一回だけ実行するタスク。取得・適用・状態更新・削除は起動しない。
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$taskPath = '\my-app2\'
$taskName = 'GmailIngest-WeeklyCheck'
$nodeExe = (Resolve-Path -LiteralPath $NodePath).Path
function ConvertTo-XmlText([string]$Value) { [System.Security.SecurityElement]::Escape($Value) }
$command = ConvertTo-XmlText $nodeExe
$script = Join-Path $root 'tools/weekly-check.mjs'
$report = Join-Path $root 'logs/weekly-check.txt'
$arguments = ConvertTo-XmlText ('"' + $script + '" --since-days 7 --out "' + $report + '"')
$workingDirectory = ConvertTo-XmlText $root
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$start = ConvertTo-XmlText $StartBoundary
$xml = @"
<?xml version="1.0"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <TimeTrigger><StartBoundary>$start</StartBoundary><Enabled>true</Enabled></TimeTrigger>
  </Triggers>
  <Principals><Principal id="GmailIngestUser"><UserId>$sid</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>
  </Settings>
  <Actions Context="GmailIngestUser"><Exec><Command>$command</Command><Arguments>$arguments</Arguments><WorkingDirectory>$workingDirectory</WorkingDirectory></Exec></Actions>
</Task>
"@
if ($XmlOnly) { return $xml }
if ($PSCmdlet.ShouldProcess("$taskPath$taskName", 'Register task')) {
    $current = Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue
    if ($current.State -in @('Running', 'Queued')) { throw 'The existing task still has an active instance.' }
    Register-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Xml $xml -Force | Out-Null
    Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName
}
