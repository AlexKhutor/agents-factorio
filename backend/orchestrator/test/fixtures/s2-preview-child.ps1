[CmdletBinding()]
param([int]$SleepSeconds = 0)
if ($SleepSeconds -gt 0) { Start-Sleep -Seconds $SleepSeconds }
[Console]::Out.WriteLine('child-out')
[Console]::Error.WriteLine('child-error')
exit 7
