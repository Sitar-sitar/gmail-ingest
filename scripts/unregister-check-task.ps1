[CmdletBinding(SupportsShouldProcess)]
param([switch]$DisableOnly)
$ErrorActionPreference = 'Stop'
$taskPath = '\my-app2\'
$taskName = 'GmailIngest-WeeklyCheck'
$task = Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $task) { return }
if ($PSCmdlet.ShouldProcess("$taskPath$taskName", 'Disable task and remove it once idle')) {
    Disable-ScheduledTask -TaskPath $taskPath -TaskName $taskName | Out-Null
    if ($DisableOnly) { return }
    if ((Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName).State -in @('Running', 'Queued')) {
        throw 'The task is disabled and an instance is still active. Retry after it exits.'
    }
    Unregister-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Confirm:$false
}
