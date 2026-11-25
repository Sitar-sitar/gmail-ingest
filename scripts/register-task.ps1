[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$NodePath = 'C:\Program Files\nodejs\node.exe',
    [string]$ProfilePath,
    [switch]$XmlOnly
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$taskPath = '\my-app2\'
$taskName = 'GmailIngest-Weekly'
$profileArgument = ''
if ($ProfilePath) {
    $ProfilePath = (Resolve-Path -LiteralPath $ProfilePath).Path
    $taskName += '-Test'
    $profileArgument = ' --profile "' + $ProfilePath + '" --test-weekly'
} elseif (-not $XmlOnly) {
    $approval = Get-Content -LiteralPath (Join-Path $root 'state/cutover.json') -Raw | ConvertFrom-Json
    if ($approval.stage -ne 'first-run-verified') { throw 'Cutover approval and a verified first run are required.' }
}
$nodeExe = (Resolve-Path -LiteralPath $NodePath).Path
function ConvertTo-XmlText([string]$Value) { [System.Security.SecurityElement]::Escape($Value) }
$command = ConvertTo-XmlText $nodeExe
$arguments = ConvertTo-XmlText ('"' + (Join-Path $root 'run.mjs') + '"' + $profileArgument)
$workingDirectory = ConvertTo-XmlText $root
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$subscription = ConvertTo-XmlText '<QueryList><Query Id="0" Path="Microsoft-Windows-NetworkProfile/Operational"><Select Path="Microsoft-Windows-NetworkProfile/Operational">*[System[EventID=10000]]</Select></Query></QueryList>'
$xml = @"
<?xml version="1.0"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <CalendarTrigger><StartBoundary>2026-11-29T22:00:00+09:00</StartBoundary><Enabled>true</Enabled><ScheduleByWeek><WeeksInterval>1</WeeksInterval><DaysOfWeek><Sunday/></DaysOfWeek></ScheduleByWeek></CalendarTrigger>
    <LogonTrigger><Enabled>true</Enabled><UserId>$sid</UserId></LogonTrigger>
    <BootTrigger><Enabled>true</Enabled></BootTrigger>
    <EventTrigger><Enabled>true</Enabled><Subscription>$subscription</Subscription></EventTrigger>
  </Triggers>
  <Principals><Principal id="GmailIngestUser"><UserId>$sid</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable><WakeToRun>true</WakeToRun>
    <ExecutionTimeLimit>PT2H</ExecutionTimeLimit><RestartOnFailure><Interval>PT30M</Interval><Count>1</Count></RestartOnFailure>
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
