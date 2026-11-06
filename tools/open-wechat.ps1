param(
    [switch]$CheckOnly,
    [switch]$Status,
    [string]$Cli = 'E:/DevTools/WeChatDevTools/cli.bat'
)
$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $projectRoot
if (-not (Test-Path -LiteralPath $Cli -PathType Leaf)) { throw "WeChat CLI not found: $Cli" }
$identityOutput = & node (Join-Path $PSScriptRoot 'build-config.mjs') --wechat-identity
if ($LASTEXITCODE -ne 0) { throw 'WeChat identity configuration is missing or invalid' }
$identity = $identityOutput | ConvertFrom-Json
$expectedAppId = $identity.appid
$buildRoot = Join-Path $projectRoot 'game/build/wechatgame'
if ($CheckOnly) {
    [ordered]@{ project = $buildRoot; appid = $expectedAppId; orientation = $identity.orientation; entryExists = (Test-Path -LiteralPath (Join-Path $buildRoot 'game.js')); opened = $false } | ConvertTo-Json
    exit 0
}
if ($Status) {
    # CLI status query only; no project-open command and no upload/preview operation.
    $cliDirectory = [System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($Cli))
    $runningDevtools = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($cliDirectory, [System.StringComparison]::OrdinalIgnoreCase) })
    if ($runningDevtools.Count -eq 0) { throw 'DevTools is not running; status mode will not launch a remembered project' }
    & $Cli islogin --lang en
    if ($LASTEXITCODE -ne 0) { throw "WeChat status query failed: $LASTEXITCODE" }
    exit 0
}
& node (Join-Path $PSScriptRoot 'check-game.mjs') --target wechatgame
if ($LASTEXITCODE -ne 0) { throw 'A current, verified WeChat build is required before opening the IDE' }
$generatedConfigPath = Join-Path $buildRoot 'project.config.json'
if (-not (Test-Path -LiteralPath $generatedConfigPath -PathType Leaf)) { throw 'Generated project.config.json is missing' }
$generatedConfig = Get-Content -LiteralPath $generatedConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($generatedConfig.appid -ne $expectedAppId -or $generatedConfig.compileType -ne 'game') { throw 'Generated project identity/type mismatch; refusing to open another project' }
if (-not (Test-Path -LiteralPath (Join-Path $buildRoot 'game.json') -PathType Leaf)) { throw 'Generated game.json is missing' }
& $Cli open --project $buildRoot --lang en
if ($LASTEXITCODE -ne 0) { throw "WeChat project open failed: $LASTEXITCODE" }
Write-Output 'Open request completed for this project only; this does not certify gameplay or device acceptance.'
