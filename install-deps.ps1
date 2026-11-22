# terminalkeeper Windows 依赖检查（只检查，不安装）
#
# 用法（在仓库或插件目录下）：
#   powershell -ExecutionPolicy Bypass -File .\install-deps.ps1
#   pwsh -File .\install-deps.ps1
#
# 边界：本脚本不会调用 winget/choco/npm install，也不会改系统目录。
# 缺失依赖时只打印命令，由用户自己执行；插件安装器也不会自动调用本脚本。

$ErrorActionPreference = 'Stop'

function Write-Ok($text) { Write-Host "[ok] $text" -ForegroundColor Green }
function Write-Warn($text) { Write-Host "[warn] $text" -ForegroundColor Yellow }
function Write-Fail($text) { Write-Host "[fail] $text" -ForegroundColor Red }

Write-Host "`nterminalkeeper Windows 依赖检查（只读）`n"

$missing = 0

$node = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $node) {
  Write-Fail 'node 未找到：请先安装 Node.js >= 20（用户自行安装）'
  $missing++
} else {
  $version = (& node --version).Trim()
  $major = [int](($version -replace '^v', '').Split('.')[0])
  if ($major -lt 20) {
    Write-Fail "Node.js $version < 20"
    $missing++
  } else {
    Write-Ok "Node.js $version"
  }
}

$pwsh = Get-Command pwsh -ErrorAction SilentlyContinue
$powershell = Get-Command powershell -ErrorAction SilentlyContinue
$cmd = Get-Command cmd -ErrorAction SilentlyContinue
if ($null -ne $pwsh) {
  Write-Ok "pwsh: $($pwsh.Source)"
} elseif ($null -ne $powershell) {
  Write-Warn "pwsh 未找到，将回退 powershell: $($powershell.Source)"
} elseif ($null -ne $cmd) {
  Write-Warn "PowerShell 未找到，将回退 cmd: $($cmd.Source)"
} else {
  Write-Fail 'pwsh / powershell / cmd 都未找到'
  $missing++
}

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
if ($null -ne $node) {
  $probe = @'
const root = process.argv[1];
for (const name of ['node-pty', '@xterm/headless']) {
  try { require.resolve(name, { paths: [root] }); console.log('ok ' + name); }
  catch { console.log('missing ' + name); }
}
'@
  $probeResult = & node -e $probe $root 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Fail "依赖探测失败：$probeResult"
    $missing++
  } else {
    foreach ($line in @($probeResult)) {
      if ($line -match '^ok ') { Write-Ok $line.Substring(3) }
      elseif ($line -match '^missing ') {
        Write-Warn "缺少 $($line.Substring(8))"
        $missing++
      }
    }
  }
}

if ($missing -gt 0) {
  Write-Host "`n缺少 $missing 项。请由用户本人执行安装，脚本不会代装：`n"
  Write-Host "  npm install --save-optional node-pty @xterm/headless"
  Write-Host "  或按你的部署方式安装 terminalkeeper 的 optionalDependencies。`n"
  Write-Host "WSL2 路径不需要这些 Windows PTY 依赖；在 WSL2 内按 Linux 安装 tmux 即可。"
  exit 1
}

Write-Host "`n依赖齐备。下一步：重启 dsh web，确认插件面板可用。"
exit 0
