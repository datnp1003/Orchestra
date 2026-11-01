param([string]$Exe, [string]$Page, [string]$Out, [int]$WaitSec = 9)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
[Win32]::SetProcessDPIAware() | Out-Null

$p = Start-Process -FilePath $Exe -ArgumentList "--page=$Page" -PassThru
Start-Sleep -Seconds $WaitSec
$p.Refresh()
# foreground mọi window của process (MainWindowHandle có thể là helper ẩn)
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinEnum {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int n);
}
"@
$target = [IntPtr]::Zero
$cb = [WinEnum+EnumProc]{
  param($h, $l)
  $pid2 = 0
  [WinEnum]::GetWindowThreadProcessId($h, [ref]$pid2) | Out-Null
  if ($pid2 -eq $p.Id -and [WinEnum]::IsWindowVisible($h)) {
    $sb = New-Object System.Text.StringBuilder 256
    [WinEnum]::GetWindowText($h, $sb, 256) | Out-Null
    if ($sb.ToString() -like '*Orchestra*') { $script:target = $h; return $false }
  }
  return $true
}
[WinEnum]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
if ($target -ne [IntPtr]::Zero) {
  [Win32]::ShowWindow($target, 3) | Out-Null
  [Win32]::SetForegroundWindow($target) | Out-Null
}
Start-Sleep -Seconds 2
# full virtual screen
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $bmp.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "SAVED $Out ${$vs.Width}x${$vs.Height}"
Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
