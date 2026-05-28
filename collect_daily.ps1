# TFT Coach — daily data collection pipeline
# Runs: collect_pro.py -> features.py -> train.py
# Logs to: logs/collect_YYYY-MM-DD.log

$ProjectDir = "C:\Users\Tiffany\tft-coach"
$Python = "C:\Users\Tiffany\AppData\Local\Programs\Python\Python314\python.exe"
$LogDir = "$ProjectDir\logs"
$Date = Get-Date -Format "yyyy-MM-dd"
$Log = "$LogDir\collect_$Date.log"

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }

function Log($msg) {
    $ts = Get-Date -Format "HH:mm:ss"
    "$ts  $msg" | Tee-Object -Append -FilePath $Log
}

Set-Location $ProjectDir

Log "=== TFT daily collection started ==="

Log "Step 1/3: Collecting match data..."
& $Python src\collect_pro.py >> $Log 2>&1
if ($LASTEXITCODE -ne 0) { Log "ERROR: collect_pro.py failed (exit $LASTEXITCODE). Aborting."; exit 1 }

Log "Step 2/3: Building features..."
& $Python src\features.py >> $Log 2>&1
if ($LASTEXITCODE -ne 0) { Log "ERROR: features.py failed (exit $LASTEXITCODE). Aborting."; exit 1 }

Log "Step 3/3: Retraining model..."
& $Python src\train.py >> $Log 2>&1
if ($LASTEXITCODE -ne 0) { Log "ERROR: train.py failed (exit $LASTEXITCODE). Aborting."; exit 1 }

Log "=== Done. ==="
