#!/usr/bin/env bash
#
# terminalkeeper 依赖自检与安装。
#
# 为什么有这个脚本：这个插件需要在**真终端**里干活，用到的 tmux 是**系统依赖** ——
# 它不在 package.json 里，包管理器装完一个字都不会说。没有 tmux 的机器会一路"装成功"，
# 然后在第一次开会话时抛一个谁也看不懂的错误。
#
# 给 AI 的用法（用户说"帮我装 terminalkeeper 这个插件"时）：
#   1. 先跑 `./install-deps.sh --check` 看缺什么（只读，不装东西，不 sudo）；
#   2. 缺什么就跑 `./install-deps.sh --yes` 装上（会 sudo，只装缺的）；
#   3. 装完把结论告诉用户：装了什么、版本多少、还需要他做什么（例如重启 dsh web）。
#
# 退出码：0 = 依赖齐备（或本次已装好）；1 = 仍有缺失（--check 模式下即"需要安装"）。
#
set -uo pipefail

MODE="check"
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --check) MODE="check" ;;
    --install|--yes|-y) MODE="install"; ASSUME_YES=1 ;;
    --audit-lock) MODE="audit-lock" ;;
    --help|-h) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$arg（可用：--check / --yes / --audit-lock / --help）" >&2; exit 2 ;;
  esac
done

# DSH 自己会在需要时装上（node 由 DSH 的运行时分发），所以只需检查、不安装。
# 真正需要用户装的只有 tmux 这类系统依赖。
NEED_ROOT_INSTALL=0
FAILED=0

say()  { printf '%s\n' "$*"; }
ok()   { printf '  [ok]      %s\n' "$*"; }
miss() { printf '  [missing] %s\n' "$*"; }
note() { printf '  [note]    %s\n' "$*"; }

detect_pm() {
  # Termux（Android）要**最先**判：它自带 apt 命令，但那是 pkg 的包装、且**没有 sudo** ——
  # 落到 apt 分支会给出必然失败的 `sudo apt-get install`（B3b 修复）。
  if [ -n "${PREFIX:-}" ] && command -v pkg >/dev/null 2>&1; then echo pkg; return; fi
  if command -v brew >/dev/null 2>&1; then echo brew; return; fi
  if command -v apt-get >/dev/null 2>&1; then echo apt; return; fi
  if command -v dnf >/dev/null 2>&1; then echo dnf; return; fi
  if command -v yum >/dev/null 2>&1; then echo yum; return; fi
  if command -v pacman >/dev/null 2>&1; then echo pacman; return; fi
  if command -v zypper >/dev/null 2>&1; then echo zypper; return; fi
  if command -v apk >/dev/null 2>&1; then echo apk; return; fi
  echo none
}

install_cmd_for() {   # $1 = package
  case "$(detect_pm)" in
    pkg)    echo "pkg install -y $1" ;;   # Termux：无 sudo
    brew)   echo "brew install $1" ;;
    apt)    echo "sudo apt-get update && sudo apt-get install -y $1" ;;
    dnf)    echo "sudo dnf install -y $1" ;;
    yum)    echo "sudo yum install -y $1" ;;
    pacman) echo "sudo pacman -S --noconfirm $1" ;;
    zypper) echo "sudo zypper install -y $1" ;;
    apk)    echo "sudo apk add $1" ;;
    *)      echo "" ;;
  esac
}

say "terminalkeeper · 依赖自检（模式：$MODE）"
say ""

# ── 1. DSH 运行时（不检查安装，只提示它自带什么）─────────────────────────────
say "由 DSH 提供（本脚本不安装）："
ok "node / npm —— 随 DSH 分发；@deepseek-ai/* 对等依赖由 DSH 的模块代理提供"
note "权限预设需为 danger-full-access，否则建 shell 会失败（受限沙箱下 tmux 服务端无法跨调用共享）"
if [ "${DSH_PERMISSION_MODE:-}" != "" ]; then
  if [ "${DSH_PERMISSION_MODE}" = "danger-full-access" ]; then
    ok "DSH_PERMISSION_MODE=${DSH_PERMISSION_MODE}"
  else
    miss "DSH_PERMISSION_MODE=${DSH_PERMISSION_MODE}（需要 danger-full-access）"
  fi
fi
say ""

# ── 2. 系统依赖：tmux ────────────────────────────────────────────────────────
say "需要操作系统提供："
TMUX_BIN="$(command -v tmux || true)"
if [ -n "$TMUX_BIN" ]; then
  TMUX_VERSION="$(tmux -V 2>/dev/null | head -1)"
  ok "tmux —— $TMUX_VERSION（$TMUX_BIN）"
  # extended-keys 需要 ≥ 3.2；低于它只是那一个可选功能不可用，不影响主流程
  MINOR="$(printf '%s' "$TMUX_VERSION" | sed -n 's/.*tmux \([0-9]*\)\.\([0-9]*\).*/\2/p')"
  MAJOR="$(printf '%s' "$TMUX_VERSION" | sed -n 's/.*tmux \([0-9]*\)\..*/\1/p')"
  if [ -n "${MAJOR:-}" ] && [ "${MAJOR:-0}" -lt 3 ]; then
    note "tmux < 3：可用，但 extendedKeys（TUI 的 Shift+Enter）不可用，且部分选项行为可能不同"
  elif [ -n "${MINOR:-}" ] && [ "${MINOR:-0}" -lt 2 ]; then
    note "tmux 3.$MINOR：可用；extendedKeys 需要 ≥ 3.2"
  fi
else
  miss "tmux —— 未安装（本插件的持久化 shell 靠它，没它就完全不能用）"
  NEED_ROOT_INSTALL=1
fi

# 顺带报告几个常见缺项（不影响本插件，但会在别处让用户困惑）
for extra in bash setsid; do
  if command -v "$extra" >/dev/null 2>&1; then ok "$extra"; else note "$extra 未找到（可选；setsid 用于孤儿看门狗）"; fi
done
say ""

if [ "$MODE" = "audit-lock" ]; then
  AUDIT_DIR="${DSH_HOME:-$HOME/.dsh}/terminalkeeper"
  say "── 审计目录加锁（chattr +a，内核级只追加）──────────────────────"
  say ""
  say "做什么：给 ${AUDIT_DIR} 设置 append-only 属性 —— 之后任何人都不能在其中"
  say "        删除/改名文件（连你自己用普通权限也不行），只能追加。审计从"
  say "        「篡改可检测」升级为「不可篡改」。"
  say ""
  say "代价：插件也无法再自动清理过期日志 —— 需要人工 sudo 归档。"
  say "      若要解除锁：sudo chattr -a ${AUDIT_DIR}"
  say ""
  say "将执行："
  say "    mkdir -p \"${AUDIT_DIR}\""
  say "    sudo chattr +a \"${AUDIT_DIR}\""
  say ""
  if [ ! -d "$AUDIT_DIR" ]; then
    note "目录不存在，先创建它"
  fi
  if [ "$ASSUME_YES" -ne 1 ]; then
    printf '继续（需要 sudo，会问你要密码）？[y/N] '
    read -r answer
    case "$answer" in y|Y|yes|YES) ;; *) say "已取消。"; exit 1 ;; esac
  fi
  mkdir -p "$AUDIT_DIR"
  if sudo chattr +a "$AUDIT_DIR"; then
    ok "已加锁：$AUDIT_DIR"
    if command -v lsattr >/dev/null 2>&1; then
      say "复核：$(lsattr -d "$AUDIT_DIR" 2>/dev/null | awk '{print $1}')"
    fi
    say "结论：审计目录改为内核级只追加（不可篡改）。面板 ⓘ 详情会出现「🔒已加锁」。"
    say "注意：此处不用再重启 dsh web（锁是文件系统属性，立即生效）。"
    exit 0
  fi
  say "加锁失败（可能是 chattr 不支持、WSL 文件系统限制、或 sudo 被拒）。"
  say "脚本不改任何东西，插件仍以「可检测」模式工作。"
  exit 1
fi

# ── 3. 结论 / 安装 ──────────────────────────────────────────────────────────
if [ "$NEED_ROOT_INSTALL" -eq 0 ]; then
  say "结论：依赖齐备，可以直接用。"
  say "下一步：重启 dsh web，然后打开面板 ⓘ 确认「tmux」一行显示版本号。"
  exit 0
fi

CMD="$(install_cmd_for tmux)"
if [ -z "$CMD" ]; then
  say "结论：缺 tmux，但没识别出这台机器的包管理器。"
  say "请手动安装 tmux（Windows 需在 WSL 里运行 DSH），然后重新执行本脚本 --check。"
  exit 1
fi


if [ "$MODE" = "check" ]; then
  say "结论：缺 tmux。安装命令："
  say "  $CMD"
  say "（加 --yes 让本脚本直接执行；也可以交给 AI 执行。）"
  exit 1
fi

say "即将执行：$CMD"
if [ "$ASSUME_YES" -ne 1 ]; then
  printf '继续？[y/N] '
  read -r answer
  case "$answer" in y|Y|yes|YES) ;; *) say "已取消。"; exit 1 ;; esac
fi
if ! sh -c "$CMD"; then
  say "安装失败。请手动执行上面的命令，或检查网络/权限后重试。"
  exit 1
fi

if command -v tmux >/dev/null 2>&1; then
  ok "tmux 已安装：$(tmux -V 2>/dev/null | head -1)"
  say "结论：依赖已装好。下一步：重启 dsh web。"
  exit 0
fi
say "安装命令执行完了，但仍然找不到 tmux —— 可能需要新开一个 shell（PATH 未刷新），或安装被中断。"
exit 1
