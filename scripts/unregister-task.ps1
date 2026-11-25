[CmdletBinding(SupportsShouldProcess)]
param([switch]$TestTask, [switch]$DisableOnly)
$ErrorActionPreference = 'Stop'
$taskPath = '\my-app2\'
$taskName = if ($TestTask) { 'GmailIngest-Weekly-Test' } else { 'GmailIngest-Weekly' }
$task = Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $task) { return }
if ($PSCmdlet.ShouldProcess("$taskPath$taskName", 'Disable task and remove it once idle')) {
    Disable-ScheduledTask -TaskPath $taskPath -TaskName $taskName | Out-Null
    if ($DisableOnly) { return }
    $scheduler = New-Object -ComObject 'Schedule.Service'
    $scheduler.Connect()
    $instances = $scheduler.GetFolder('\my-app2').GetTask($taskName).GetInstances(0)
    if ($instances.Count -gt 0) { throw 'The task is disabled and an instance is still active. Retry after it exits.' }
    Unregister-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Confirm:$false
}
