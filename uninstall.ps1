# dsh-audio-player — 卸载脚本
# 只移除安装登记与 node_modules 联接，不删除音频和设置。
# 用法：powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -Profile desktop

[CmdletBinding()]
param(
  [ValidateSet('desktop', 'web')]
  [string]$Profile = 'desktop',
  [string]$DshHome = (Join-Path $HOME '.dsh')
)

$ErrorActionPreference = 'Stop'
$profileDir = Join-Path $DshHome (Join-Path 'profiles' $Profile)
$target = Join-Path (Join-Path $profileDir 'node_modules') 'dsh-audio-player'
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Read-Utf8([string]$path) {
  return [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
}

function Write-Utf8([string]$path, [string]$text) {
  [System.IO.File]::WriteAllText($path, $text, $utf8)
}

if (-not (Test-Path -LiteralPath $profileDir)) {
  throw "找不到 profile 目录：$profileDir"
}

# 1) 去掉 node_modules 联接 / 副本
if (Test-Path -LiteralPath $target) {
  $item = Get-Item -LiteralPath $target -Force
  if ($item.LinkType) {
    cmd /c rmdir "`"$target`"" | Out-Null
  } else {
    Remove-Item -LiteralPath $target -Recurse -Force
  }
  Write-Host "已移除：$target"
}

# 2) 桌面端：从 cordis.patch.yml 删除 insert 行
$patchPath = Join-Path $profileDir 'cordis.patch.yml'
if ($Profile -eq 'desktop' -and (Test-Path -LiteralPath $patchPath)) {
  $text = Read-Utf8 $patchPath
  $before = $text
  $text = [regex]::Replace($text, '(?ms)\r?\n?# dsh-audio-player[^\r\n]*\r?\n- insert:\r?\n\s+- id: dsh-audio-player\r?\n\s+name: dsh-audio-player\r?\n?', "`r`n")
  $text = [regex]::Replace($text, '(?ms)\r?\n?- insert:\r?\n\s+- id: dsh-audio-player\r?\n\s+name: dsh-audio-player\r?\n?', "`r`n")
  if ($text.Trim().Length -eq 0) { $text = "[]`r`n" }
  if ($text -ne $before) {
    Copy-Item -LiteralPath $patchPath -Destination ($patchPath + '.bak-audio-' + (Get-Date -Format 'yyyyMMddHHmmss')) -Force
    Write-Utf8 $patchPath $text
    Write-Host '已从 cordis.patch.yml 移除插件行。'
  }
}

# 3) 从 profile 的 package.json 删除依赖 / bundle 登记
$pkgPath = Join-Path $profileDir 'package.json'
if (Test-Path -LiteralPath $pkgPath) {
  $pkg = (Read-Utf8 $pkgPath) | ConvertFrom-Json
  $changed = $false
  if ($null -ne $pkg.PSObject.Properties['dependencies'] -and $null -ne $pkg.dependencies.PSObject.Properties['dsh-audio-player']) {
    $pkg.dependencies.PSObject.Properties.Remove('dsh-audio-player')
    $changed = $true
  }
  if ($Profile -eq 'web' -and $null -ne $pkg.PSObject.Properties['dsh'] -and $null -ne $pkg.dsh.PSObject.Properties['profile'] -and $null -ne $pkg.dsh.profile.PSObject.Properties['bundles']) {
    $bundles = @($pkg.dsh.profile.bundles | Where-Object { $_ -and $_ -ne 'dsh-audio-player' })
    $pkg.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue $bundles -Force
    $changed = $true
  }
  if ($changed) {
    Copy-Item -LiteralPath $pkgPath -Destination ($pkgPath + '.bak-audio-' + (Get-Date -Format 'yyyyMMddHHmmss')) -Force
    Write-Utf8 $pkgPath (($pkg | ConvertTo-Json -Depth 20) + "`r`n")
    Write-Host '已从 package.json 移除依赖 / bundle 登记。'
  }
}

Write-Host ''
Write-Host 'dsh-audio-player 已卸载。' -ForegroundColor Green
Write-Host '音频和设置仍保留在：' (Join-Path $DshHome 'dsh-audio-player')
Write-Host '需要时手工删除该目录即可彻底清理。'
