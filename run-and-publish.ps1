# outlier-caucus: generate report then publish
# Designed for use with Windows Task Scheduler

$ProjectDir = $PSScriptRoot
$LogDir = "$ProjectDir\logs"
$LogFile = "$LogDir\outlier-caucus-$(Get-Date -Format 'yyyy-MM-dd').log"
$NodeExe = "node"

# Decode native command output (node's emoji) as UTF-8 instead of the OEM codepage
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }

# Append lines to the log as UTF-8 (Tee-Object/Out-File in PS 5.1 write UTF-16 or a BOM)
function Add-LogLine {
    param([string]$Line)
    [System.IO.File]::AppendAllText($LogFile, "$Line`r`n", $Utf8NoBom)
}

function Write-Log {
    param([string]$Message)
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $Message"
    Add-LogLine $line
    $line
}

# Pipe native output through here: stderr lines arrive as ErrorRecords under 2>&1,
# which PS 5.1 would render as NativeCommandError blocks — log them as plain text.
filter Out-NativeLog {
    if ($_ -is [System.Management.Automation.ErrorRecord]) { $line = $_.Exception.Message } else { $line = "$_" }
    Add-LogLine $line
    $line
}

Set-Location $ProjectDir

Write-Log "=== Starting pipeline ==="

Write-Log "Building..."
& npm run build 2>&1 | Out-NativeLog
if ($LASTEXITCODE -ne 0) {
    Write-Log "Build failed with exit code $LASTEXITCODE. Aborting."
    exit $LASTEXITCODE
}

# Route node's warnings/errors to stdout so log lines stay in order (see src/index.ts)
$env:LOG_TO_STDOUT = "1"
& $NodeExe --env-file-if-exists=.env dist/index.js report:html --publish --skip-unchanged 2>&1 | Out-NativeLog
if ($LASTEXITCODE -ne 0) {
    Write-Log "Pipeline failed with exit code $LASTEXITCODE."
    exit $LASTEXITCODE
}

Write-Log "Pipeline complete."
