param([string]$Exe, [string]$Page, [string]$Out, [int]$WaitSec = 9)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
public class Win32 {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
}
"@
[Win32]::SetProcessDPIAware() | Out-Null

$p = Start-Process -FilePath $Exe -ArgumentList "--page=$Page" -PassThru
Start-Sleep -Seconds $WaitSec
$p.Refresh()

# find the process's "Orchestra*" window — even if covered (PrintWindow doesn't need foreground)
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WE2 {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
}
"@
$target = [IntPtr]::Zero
$errDlg = $false
$cb = [WE2+EnumProc]{
  param($h, $l)
  $pid2 = 0
  [WE2]::GetWindowThreadProcessId($h, [ref]$pid2) | Out-Null
  if ($pid2 -eq $p.Id -and [WE2]::IsWindowVisible($h)) {
    $sb = New-Object System.Text.StringBuilder 256
    [WE2]::GetWindowText($h, $sb, 256) | Out-Null
    $t = $sb.ToString()
    if ($t -eq 'Error') { $script:errDlg = $true }
    if ($t -like '*Orchestra*') { $script:target = $h; return $false }
  }
  return $true
}
[WE2]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null

if ($errDlg) { Write-Output 'CRASH_DIALOG'; Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue; exit 2 }
if ($target -eq [IntPtr]::Zero) { Write-Output 'NO_ORCHESTRA_WINDOW'; Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue; exit 3 }

$r = New-Object RECT
[Win32]::GetWindowRect($target, [ref]$r) | Out-Null
$w = $r.Right - $r.Left; $ht = $r.Bottom - $r.Top
if ($w -le 0 -or $ht -le 0) { Write-Output 'BAD_RECT'; Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue; exit 4 }
$bmp = New-Object System.Drawing.Bitmap($w, $ht)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
# PW_RENDERFULLCONTENT (2) — captures GPU-rendered windows too (Electron)
[WE2]::PrintWindow($target, $hdc, 2) | Out-Null
$g.ReleaseHdc($hdc)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "SAVED $Out ${w}x${ht}"
Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
