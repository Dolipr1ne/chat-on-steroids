# Read-only inventory checks for an explicitly invoked local repair installer.
# The caller owns staging/backups/replacement; this helper never removes or edits a file.
Set-StrictMode -Version 2

function Get-CoSFileInventory([string]$Folder) {
  $root = [IO.Path]::GetFullPath($Folder).TrimEnd('\', '/')
  $base = Get-Item -LiteralPath $root -Force -ErrorAction Stop
  if (-not $base.PSIsContainer -or ($base.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'The extension directory must be an ordinary directory, not a link or junction.'
  }
  $pending = New-Object 'System.Collections.Generic.Stack[string]'
  $pending.Push($root)
  $inventory = @{}
  $entries = 0
  $bytes = [long]0
  while ($pending.Count -gt 0) {
    foreach ($entry in Get-ChildItem -LiteralPath $pending.Pop() -Force -ErrorAction Stop) {
      $entries++
      if ($entries -gt 8192) { throw 'The extension inventory exceeds the entry limit.' }
      if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('Extension link/junction refused: ' + $entry.Name) }
      if ($entry.PSIsContainer) { $pending.Push($entry.FullName); continue }
      $relative = $entry.FullName.Substring($root.Length + 1).Replace('\', '/')
      if ($relative -match '(^|/)\.\.?(/|$)|[:\\]' -or $relative.StartsWith('/')) { throw 'Invalid extension inventory path.' }
      $bytes += $entry.Length
      if ($bytes -gt 64MB -or $inventory.Count -ge 2048) { throw 'The extension inventory exceeds its file or byte limit.' }
      $inventory[$relative] = (Get-FileHash -LiteralPath $entry.FullName -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
    }
  }
  return $inventory
}

function Assert-CoSFileInventory([string]$Folder, $Expected, [switch]$AllowExtra) {
  $wanted = @{}
  if ($Expected -is [System.Collections.IDictionary]) {
    foreach ($key in $Expected.Keys) { $wanted[[string]$key] = [string]$Expected[$key] }
  } else {
    foreach ($property in $Expected.PSObject.Properties) { $wanted[$property.Name] = [string]$property.Value }
  }
  foreach ($name in $wanted.Keys) {
    if ($name -match '(^|/)\.\.?(/|$)|[:\\]' -or $name.StartsWith('/') -or $wanted[$name] -notmatch '^[a-fA-F0-9]{64}$') {
      throw 'The extension manifest contains an invalid path or hash.'
    }
  }
  $actual = Get-CoSFileInventory $Folder
  $missing = @($wanted.Keys | Where-Object { -not $actual.ContainsKey($_) } | Sort-Object)
  $changed = @($wanted.Keys | Where-Object { $actual.ContainsKey($_) -and $actual[$_] -ne $wanted[$_] } | Sort-Object)
  $extra = @($actual.Keys | Where-Object { -not $wanted.ContainsKey($_) } | Sort-Object)
  if ($missing.Count -or $changed.Count -or ($extra.Count -and -not $AllowExtra)) {
    $details = @()
    if ($missing.Count) { $details += 'missing: ' + (($missing | Select-Object -First 8) -join ', ') }
    if ($changed.Count) { $details += 'changed: ' + (($changed | Select-Object -First 8) -join ', ') }
    if ($extra.Count -and -not $AllowExtra) { $details += 'additional: ' + (($extra | Select-Object -First 8) -join ', ') }
    throw ('Extension inventory mismatch (' + ($details -join '; ') + '). No replacement was authorized.')
  }
  # Extra installed files may be retained in a full directory backup by the caller.
  # They are never accepted as part of the replacement package or executed here.
  return [pscustomobject]@{ Inventory = $actual; ExtraFiles = $extra }
}
