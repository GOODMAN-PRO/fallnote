$ErrorActionPreference = 'Stop'
$appRoot = Split-Path -Parent $PSScriptRoot
$appUrl = 'http://127.0.0.1:8788'
foreach ($appCommand in @('node', 'ffmpeg', 'ffprobe', 'yt-dlp')) {
    if (-not (Get-Command $appCommand -ErrorAction SilentlyContinue)) {
        Write-Host "Fallnote needs $appCommand. See README.md for installation."
        exit 1
    }
}
try {
    $appStatus = Invoke-RestMethod "$appUrl/api/status" -TimeoutSec 3
    if ($appStatus.local -and $appStatus.repository) {
        Start-Process $appUrl
        exit 0
    }
} catch {}
$logFolder = Join-Path $appRoot '.local'
New-Item -ItemType Directory -Path $logFolder -Force | Out-Null
$nodeExecutable = (Get-Command node).Source
$appProcess = Start-Process -FilePath $nodeExecutable -ArgumentList @('server.mjs') -WorkingDirectory $appRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logFolder 'server.log') -RedirectStandardError (Join-Path $logFolder 'server-error.log')
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 500
    try {
        $appStatus = Invoke-RestMethod "$appUrl/api/status" -TimeoutSec 2
        if ($appStatus.local) {
            Write-Host "Fallnote is running at $appUrl (process $($appProcess.Id))."
            Start-Process $appUrl
            exit 0
        }
    } catch {}
    if ($appProcess.HasExited) { break }
}
Write-Host 'Fallnote could not start. Check .local\server-error.log.'
exit 1
