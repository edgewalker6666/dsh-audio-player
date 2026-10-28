# dsh-audio-player — 安装脚本
# 用法：
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Profile desktop
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Profile web

[CmdletBinding()]
param(
  [ValidateSet('desktop', 'web')]
  [string]$Profile = 'desktop',
  [string]$DshHome = (Join-Path $HOME '.dsh')
)

$ErrorActionPreference = 'Stop'
$plugin = $PSScriptRoot
$profileDir = Join-Path $DshHome (Join-Path 'profiles' $Profile)
$modulesDir = Join-Path $profileDir 'node_modules'
$target = Join-Path $modulesDir 'dsh-audio-player'
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Read-Utf8([string]$path) {
  return [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
}

function Write-Utf8([string]$path, [string]$text) {
  $dir = Split-Path -Parent $path
  if ($dir -and -not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  [System.IO.File]::WriteAllText($path, $text, $utf8)
}

function Has-Prop($object, [string]$name) {
  return $null -ne $object.PSObject.Properties[$name]
}

if (-not (Test-Path -LiteralPath $profileDir)) {
  throw "找不到 profile 目录：$profileDir。请先在 DSH 里打开过 $Profile 端。"
}
if (-not (Test-Path -LiteralPath (Join-Path $plugin 'lib\index.js'))) {
  throw "插件目录不完整（缺少 lib\index.js）：$plugin"
}

New-Item -ItemType Directory -Path $modulesDir -Force | Out-Null

# 1) 目录联接
if (Test-Path -LiteralPath $target) {
  $item = Get-Item -LiteralPath $target -Force
  if ($item.LinkType) {
    cmd /c rmdir "`"$target`"" | Out-Null
  } else {
    Remove-Item -LiteralPath $target -Recurse -Force
  }
}
cmd /c mklink /J "`"$target`"" "`"$plugin`"" | Out-Null
if (-not (Test-Path -LiteralPath (Join-Path $target 'lib\index.js'))) {
  throw "创建目录联接失败：$target"
}

# 2) 让 profile 能长期解析到这个包
$pkgPath = Join-Path $profileDir 'package.json'
if (Test-Path -LiteralPath $pkgPath) {
  $pkgText = Read-Utf8 $pkgPath
  $pkg = $pkgText | ConvertFrom-Json
  if (-not (Has-Prop $pkg 'dependencies') -or $null -eq $pkg.dependencies) {
    $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) -Force
  }
  $fileSpec = 'file:' + $plugin.Replace('\', '/')
  $pkg.dependencies | Add-Member -NotePropertyName 'dsh-audio-player' -NotePropertyValue $fileSpec -Force

  if ($Profile -eq 'web') {
    if (-not (Has-Prop $pkg 'dsh') -or $null -eq $pkg.dsh) {
      $pkg | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{ profile = [pscustomobject]@{ bundles = @() } }) -Force
    }
    if (-not (Has-Prop $pkg.dsh 'profile') -or $null -eq $pkg.dsh.profile) {
      $pkg.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{ bundles = @() }) -Force
    }
    $bundles = @($pkg.dsh.profile.bundles | Where-Object { $_ })
    if ($bundles -notcontains 'dsh-audio-player') {
      $bundles += 'dsh-audio-player'
    }
    $pkg.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue $bundles -Force
  }

  Copy-Item -LiteralPath $pkgPath -Destination ($pkgPath + '.bak-audio-' + (Get-Date -Format 'yyyyMMddHHmmss')) -Force
  Write-Utf8 $pkgPath (($pkg | ConvertTo-Json -Depth 20) + "`r`n")
}

# 3) 桌面端：profile patch 里插入插件（可热加载，无需重启）
if ($Profile -eq 'desktop') {
  $patchPath = Join-Path $profileDir 'cordis.patch.yml'
  $patchText = if (Test-Path -LiteralPath $patchPath) { Read-Utf8 $patchPath } else { "[]`r`n" }
  $patchText = [regex]::Replace($patchText, '(?m)^\s*\[\]\s*\r?\n?', '')
  if ($patchText.Trim().Length -eq 0) {
    $patchText = ''
  }
  if ($patchText -notmatch '(?m)^\s*-\s*id:\s*dsh-audio-player\s*$') {
    $block = @(
      '',
      '# dsh-audio-player — 独立 MP3 播放器（本地安装）',
      '- insert:',
      '    - id: dsh-audio-player',
      '      name: dsh-audio-player',
      ''
    ) -join "`r`n"
    Copy-Item -LiteralPath $patchPath -Destination ($patchPath + '.bak-audio-' + (Get-Date -Format 'yyyyMMddHHmmss')) -Force -ErrorAction SilentlyContinue
    Write-Utf8 $patchPath ($patchText.TrimEnd() + "`r`n" + $block)
  }
}

Write-Host ''
Write-Host 'dsh-audio-player 已安装' -ForegroundColor Green
Write-Host ("  插件： " + $plugin)
Write-Host ("  联接： " + $target)
Write-Host ("  音频： " + (Join-Path $DshHome 'dsh-audio-player\tracks'))
Write-Host ''
if ($Profile -eq 'desktop') {
  Write-Host '请退出并重新打开 DeepSeek Harness（只刷新页面不会加载新的 index 注入）。' -ForegroundColor Yellow
} else {
  Write-Host '请重启 dsh web，然后刷新页面。' -ForegroundColor Yellow
}
