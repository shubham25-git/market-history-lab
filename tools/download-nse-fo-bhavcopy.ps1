param(
  [Parameter(Mandatory=$true)]
  [string]$From,

  [Parameter(Mandatory=$true)]
  [string]$To,

  [string]$OutDir = ".\data\nse-bhavcopy"
)

$ErrorActionPreference = "Stop"

function Get-DateRange {
  param([datetime]$Start, [datetime]$End)
  $date = $Start
  while ($date -le $End) {
    $date
    $date = $date.AddDays(1)
  }
}

$start = [datetime]::ParseExact($From, "yyyy-MM-dd", $null)
$end = [datetime]::ParseExact($To, "yyyy-MM-dd", $null)
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$combined = Join-Path $OutDir "nse-fo-options-$From-to-$To.csv"
$wroteHeader = $false

foreach ($day in Get-DateRange -Start $start -End $end) {
  if ($day.DayOfWeek -eq "Saturday" -or $day.DayOfWeek -eq "Sunday") {
    continue
  }

  $yyyyMMdd = $day.ToString("yyyyMMdd")
  $zipName = "BhavCopy_NSE_FO_0_0_0_${yyyyMMdd}_F_0000.csv.zip"
  $url = "https://nsearchives.nseindia.com/content/fo/$zipName"
  $zipPath = Join-Path $OutDir $zipName
  $extractDir = Join-Path $OutDir $yyyyMMdd

  try {
    Write-Host "Downloading $yyyyMMdd..."
    Invoke-WebRequest -Uri $url -OutFile $zipPath -Headers @{
      "User-Agent" = "Mozilla/5.0 MarketHistoryLab/1.0"
      "Accept" = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      "Referer" = "https://www.nseindia.com/"
    }

    if (Test-Path $extractDir) {
      Remove-Item -LiteralPath $extractDir -Recurse -Force
    }
    Expand-Archive -LiteralPath $zipPath -DestinationPath $extractDir -Force
    $csv = Get-ChildItem -LiteralPath $extractDir -Filter *.csv | Select-Object -First 1
    if (-not $csv) {
      Write-Warning "No CSV inside $zipName"
      continue
    }

    $lines = Get-Content -LiteralPath $csv.FullName
    if ($lines.Count -lt 2) {
      Write-Warning "Empty CSV for $yyyyMMdd"
      continue
    }
    if (-not $wroteHeader) {
      Set-Content -LiteralPath $combined -Value $lines[0]
      $wroteHeader = $true
    }
    Add-Content -LiteralPath $combined -Value ($lines | Select-Object -Skip 1)
  } catch {
    Write-Warning "Skipped $yyyyMMdd: $($_.Exception.Message)"
  }
}

if ($wroteHeader) {
  Write-Host ""
  Write-Host "Done. Import this CSV in Market History Lab Data tab:"
  Write-Host (Resolve-Path $combined).Path
} else {
  Write-Error "No bhavcopy files downloaded. Check date range/network/NSE availability."
}
