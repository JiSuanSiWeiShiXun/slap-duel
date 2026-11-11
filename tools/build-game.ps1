param(
    [ValidateSet('web-desktop', 'wechatgame')][string]$Target = 'web-desktop',
    [string]$Creator = 'E:/DevTools/CocosCreator/3.8.8/CocosCreator.exe'
)
$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $projectRoot
& node (Join-Path $PSScriptRoot 'bootstrap-game.mjs') --check
if ($LASTEXITCODE -ne 0) { throw 'Project configuration check failed' }
if (-not (Test-Path -LiteralPath $Creator -PathType Leaf)) { throw "Creator not found: $Creator" }
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'game/assets/scripts/SlapGame.ts') -PathType Leaf)) {
    throw 'SlapGame.ts is not implemented yet; refusing a misleading empty-game build'
}
$runtimeConfigOutput = & node (Join-Path $PSScriptRoot 'build-config.mjs') $Target
if ($LASTEXITCODE -ne 0) { throw 'Runtime build configuration failed' }
$configPath = [string]$runtimeConfigOutput
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw 'Runtime build configuration missing' }
& node (Join-Path $PSScriptRoot 'check-game.mjs') --prepare $Target
if ($LASTEXITCODE -ne 0) { throw 'Build identity preparation failed' }
$gameRoot = Join-Path $projectRoot 'game'
$logDirectory = Join-Path $gameRoot 'local/build-logs'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$buildStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logPath = Join-Path $logDirectory "$Target-$buildStamp.log"
$stdoutPath = Join-Path $logDirectory "$Target-$buildStamp.stdout.log"
$stderrPath = Join-Path $logDirectory "$Target-$buildStamp.stderr.log"
foreach ($argumentPath in @($gameRoot, $configPath, $logPath)) {
    if ($argumentPath.Contains('"')) { throw 'Invalid quote in argument path' }
}
$arguments = @('--project', ('"' + $gameRoot + '"'), '--build', ('"configPath=' + $configPath.Replace('\', '/') + ';logDest=' + $logPath.Replace('\', '/') + '"'))
Write-Output "Building $Target; log: $logPath"
$buildProcess = New-Object System.Diagnostics.Process
$buildProcess.StartInfo = New-Object System.Diagnostics.ProcessStartInfo
$buildProcess.StartInfo.FileName = $Creator
$buildProcess.StartInfo.Arguments = $arguments -join ' '
$buildProcess.StartInfo.WorkingDirectory = $projectRoot
$buildProcess.StartInfo.UseShellExecute = $false
$buildProcess.StartInfo.CreateNoWindow = $true
$buildProcess.StartInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$buildProcess.StartInfo.RedirectStandardOutput = $true
$buildProcess.StartInfo.RedirectStandardError = $true
if (-not $buildProcess.Start()) { throw 'Creator process did not start' }
$stdoutRead = $buildProcess.StandardOutput.ReadToEndAsync()
$stderrRead = $buildProcess.StandardError.ReadToEndAsync()
$buildProcess.WaitForExit()
[System.IO.File]::WriteAllText($stdoutPath, $stdoutRead.Result)
[System.IO.File]::WriteAllText($stderrPath, $stderrRead.Result)
$creatorExit = $buildProcess.ExitCode
$receipt = @{ target = $Target; creator = $Creator; exitCode = $creatorExit; log = $logPath; stdout = $stdoutPath; stderr = $stderrPath; endedAt = (Get-Date).ToUniversalTime().ToString('o') }
$receipt | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $logDirectory "$Target-$buildStamp.receipt.json") -Encoding utf8
if ($creatorExit -ne 36) { throw "Cocos build failed (exit $creatorExit). See $logPath and $stderrPath" }
if ($Target -eq 'wechatgame') {
    & node (Join-Path $PSScriptRoot 'configure-wechat.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'WeChat compiler settings post-processing failed' }
    & node (Join-Path $PSScriptRoot 'check-wechat-package.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'WeChat local subpackages or main-package budget verification failed' }
}
& node (Join-Path $PSScriptRoot 'check-game.mjs') --stamp $Target
if ($LASTEXITCODE -ne 0) { throw 'Cocos reported success but output verification failed' }
& node (Join-Path $PSScriptRoot 'check-game.mjs') --target $Target
if ($LASTEXITCODE -ne 0) { throw 'Build manifest verification failed' }
Write-Output "PASS: $Target built by Cocos 3.8.8 (exit 36)."
