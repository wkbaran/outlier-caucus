# outlier-caucus: OCR the backlog of scanned/paper filings (long-running)
# Usage: .\ocr-catchup.ps1 [--limit 5] [--filing 9115726] [--chamber house] [--retry] [--force] [--list]
# The command writes its own log to logs\ocr-catchup-<timestamp>.log and per-page
# artifacts to logs\ocr\<chamber>-<id>\ for reviewing pages that fail.

$ProjectDir = $PSScriptRoot
Set-Location $ProjectDir

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

& npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Output "Build failed with exit code $LASTEXITCODE. Aborting."
    exit $LASTEXITCODE
}

$env:LOG_TO_STDOUT = "1"
& node --env-file-if-exists=.env dist/index.js ocr:catchup @args
exit $LASTEXITCODE
