$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$mutex = New-Object System.Threading.Mutex($false, 'Local\WebAiBridgeClipboard')
$locked = $false
$backup = New-Object System.Windows.Forms.DataObject
$partial = $false
$image = $null
$stream = $null
function Reply($value) { [Console]::WriteLine(($value | ConvertTo-Json -Compress)); [Console]::Out.Flush() }
try {
  $locked = $mutex.WaitOne(0)
  if (-not $locked) { throw 'CLIPBOARD_BUSY' }
  $original = [System.Windows.Forms.Clipboard]::GetDataObject()
  if ($null -ne $original) {
    foreach ($format in $original.GetFormats($false)) {
      try {
        $value = $original.GetData($format, $false)
        if ($value -is [System.Drawing.Image]) { $value = $value.Clone() }
        elseif ($value -is [System.IO.MemoryStream]) { $value = New-Object System.IO.MemoryStream(,$value.ToArray()) }
        if ($null -ne $value) { $backup.SetData($format, $false, $value) } else { $partial = $true }
      } catch { $partial = $true }
    }
  }
  Reply @{ ok = $true; partial = $partial }
  while ($null -ne ($line = [Console]::ReadLine())) {
    $request = $line | ConvertFrom-Json
    if ($request.action -eq 'restore') {
      [System.Windows.Forms.Clipboard]::SetDataObject($backup, $true)
      Reply @{ ok = $true; partial = $partial }
      break
    }
    if ($null -ne $image) { $image.Dispose(); $image = $null }
    if ($null -ne $stream) { $stream.Dispose(); $stream = $null }
    if ($request.action -eq 'image') {
      $bytes = [Convert]::FromBase64String($request.base64)
      $stream = New-Object System.IO.MemoryStream(,$bytes)
      $image = [System.Drawing.Image]::FromStream($stream)
      $data = New-Object System.Windows.Forms.DataObject
      $data.SetData([System.Windows.Forms.DataFormats]::Bitmap, $true, $image)
      $png = New-Object System.IO.MemoryStream(,$bytes)
      $data.SetData('PNG', $false, $png)
      [System.Windows.Forms.Clipboard]::SetDataObject($data, $true)
    } elseif ($request.action -eq 'files') {
      $paths = New-Object System.Collections.Specialized.StringCollection
      foreach ($path in $request.paths) { [void]$paths.Add([string]$path) }
      [System.Windows.Forms.Clipboard]::SetFileDropList($paths)
    } else { throw 'UNKNOWN_ACTION' }
    Reply @{ ok = $true }
  }
} catch {
  Reply @{ ok = $false; error = 'CLIPBOARD_FAILED' }
} finally {
  if ($locked) {
    try { [System.Windows.Forms.Clipboard]::SetDataObject($backup, $true) } catch { }
    $mutex.ReleaseMutex()
  }
  if ($null -ne $image) { $image.Dispose() }
  if ($null -ne $stream) { $stream.Dispose() }
  $mutex.Dispose()
}
