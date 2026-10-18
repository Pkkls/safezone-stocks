# Register the engine as a Windows scheduled task: starts 1 min after your logon, restarts 1 min after a crash,
# keeps running when you log off (S4U), no time limit. Run once from the project folder in an elevated PowerShell:
#   powershell -ExecutionPolicy Bypass -File scripts\register-task.ps1
# Restart later without admin rights: Stop-ScheduledTask SafezoneStocks; Start-ScheduledTask SafezoneStocks
$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node).Source
$user = $env:USERNAME
$action = New-ScheduledTaskAction -Execute $node -Argument 'engine.mjs' -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$trigger.Delay = 'PT1M'
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Limited
Register-ScheduledTask -TaskName 'SafezoneStocks' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName 'SafezoneStocks'
"SafezoneStocks registered and started from $dir"
