# Daily pro-data refresh, run by the "TFT-Coach-DailyCollect" scheduled task.
# collect_pro.py -> features.py -> slim CSV (production reads the slim one).
# Does NOT commit or push — review the counts, then push manually.

$ErrorActionPreference = 'Stop'
$root   = $PSScriptRoot
$python = 'C:\Users\Tiffany\AppData\Local\Programs\Python\Python314\python.exe'
Set-Location $root
New-Item -ItemType Directory -Force logs | Out-Null
$log = Join-Path $root "logs\collect_$(Get-Date -Format 'yyyy-MM-dd').log"

function Log($msg) { "[$(Get-Date -Format 'HH:mm:ss')] $msg" | Tee-Object -FilePath $log -Append }

# Read the key fresh from the User scope — the task's environment may predate a renewal
$env:RIOT_API_KEY = [Environment]::GetEnvironmentVariable('RIOT_API_KEY', 'User')
$env:PYTHONIOENCODING = 'utf-8'

# Skip if a collection is already running (e.g. a manual run)
$running = Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
    Where-Object { $_.CommandLine -like '*collect_pro.py*' }
if ($running) { Log "collect_pro.py already running (PID $($running.ProcessId)) - skipping"; exit 0 }

try {
    Log 'collect_pro.py starting'
    & $python -u src/collect_pro.py *>> $log
    if ($LASTEXITCODE -ne 0) { throw "collect_pro.py exited $LASTEXITCODE" }

    Log 'features.py starting'
    & $python -u src/features.py *>> $log
    if ($LASTEXITCODE -ne 0) { throw "features.py exited $LASTEXITCODE" }

    Log 'regenerating slim CSV'
    & $python -c @'
import csv
cols = ['placement','top4','level','gold_left','level_efficiency','top_trait','unit_star_avg']
inp, out = 'data/processed/match_features.csv', 'data/processed/match_features_slim.csv'
with open(inp,newline='',encoding='utf-8') as fi, open(out,'w',newline='',encoding='utf-8') as fo:
    r=csv.DictReader(fi); w=csv.DictWriter(fo,fieldnames=cols); w.writeheader()
    [w.writerow({c:row[c] for c in cols}) for row in r]
'@ *>> $log
    if ($LASTEXITCODE -ne 0) { throw "slim CSV exited $LASTEXITCODE" }

    & $python -c "import csv; [print(f, sum(1 for _ in csv.reader(open(f,newline='',encoding='utf-8')))-1) for f in ['data/processed/match_features.csv','data/processed/match_features_slim.csv']]" *>> $log
    Log 'done - review counts above, then commit + push the slim CSV'
} catch {
    Log "FAILED: $_"
    exit 1
}
