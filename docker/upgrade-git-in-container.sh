#!/bin/sh
# upgrade-git-in-container.sh —— 在容器内把 git 升到 >= 2.41（代码评审 OCR 的最低要求）。
#
# 背景：OCR(open-code-review) 全线使用 `git --end-of-options`，官方要求 Git >= 2.41；
# Debian 12(bookworm) 的 apt 只有 2.39.5，且 backports 里没有 git 包 —— 只能源码编译。
# 本脚本：装编译依赖 → 多镜像回退下载源码 → 编译安装到 /usr/local → 验证 OCR 依赖的调用。
#
# 用法（在容器内执行，需 root）：
#   1) 宿主机:  docker cp docker/upgrade-git-in-container.sh <容器名>:/tmp/upgrade-git.sh
#              docker exec -it <容器名> sh /tmp/upgrade-git.sh
#   2) 或直接把本文件内容粘进容器终端执行。
#
# 可用环境变量覆盖：GIT_VERSION（默认 2.47.3）、PREFIX（默认 /usr/local）。
# ⚠️ 产物在容器可写层：1Panel 重建容器后需重跑本脚本（要一劳永逸请用派生镜像方案）。
set -eu

GIT_VERSION="${GIT_VERSION:-2.47.3}"
PREFIX="${PREFIX:-/usr/local}"

log() { echo "==> $*"; }

# ── 0) 已经是够新的版本就直接退出（幂等，重复执行无副作用）──────────────
if command -v git >/dev/null 2>&1; then
  CUR="$(git --version | sed 's/.* //')"
  log "当前 git: $CUR"
  MINOR="$(echo "$CUR" | cut -d. -f2)"
  MAJOR="$(echo "$CUR" | cut -d. -f1)"
  if [ "$MAJOR" -gt 2 ] || { [ "$MAJOR" -eq 2 ] && [ "$MINOR" -ge 41 ]; }; then
    log "已满足 >= 2.41，无需升级（想强制重装可设 FORCE=1 后重跑）"
    [ "${FORCE:-0}" = "1" ] || exit 0
  fi
else
  log "容器内未检测到 git"
fi

# ── 1) 编译依赖 ────────────────────────────────────────────────────────
# libcurl4-openssl-dev 必须有：代码评审要 git clone/fetch https 仓库，
# 缺它编出来的 git 不支持 http(s) 传输（能编过，但 clone 直接报错）。
log "安装编译依赖（apt 慢的话见脚本末尾说明）"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  build-essential ca-certificates curl xz-utils gettext \
  libcurl4-openssl-dev libexpat1-dev zlib1g-dev libpcre2-dev

# ── 2) 下载源码（多镜像回退，国内网络优先走到能通的那个）────────────────
log "下载 git $GIT_VERSION 源码"
cd /tmp
rm -rf /tmp/git-src /tmp/git.tar
OK_URL=""
for U in \
  "https://mirrors.edge.kernel.org/pub/software/scm/git/git-$GIT_VERSION.tar.xz" \
  "https://www.kernel.org/pub/software/scm/git/git-$GIT_VERSION.tar.xz" \
  "https://github.com/git/git/archive/refs/tags/v$GIT_VERSION.tar.gz"
do
  echo "    尝试: $U"
  if curl -fL --connect-timeout 15 --retry 2 --retry-delay 2 -o /tmp/git.tar "$U"; then
    OK_URL="$U"; break
  fi
done
if [ -z "$OK_URL" ]; then
  echo "❌ 三个下载源都没通。可在宿主机下载后拷进来再重跑本脚本："
  echo "   curl -fLO https://mirrors.edge.kernel.org/pub/software/scm/git/git-$GIT_VERSION.tar.xz"
  echo "   docker cp git-$GIT_VERSION.tar.xz <容器名>:/tmp/git.tar && docker exec -it <容器名> sh /tmp/upgrade-git.sh"
  exit 1
fi
log "下载成功: $OK_URL"

# ── 3) 编译安装 ────────────────────────────────────────────────────────
log "编译（几分钟，与容器 CPU 核数有关）"
mkdir -p /tmp/git-src
tar -xf /tmp/git.tar -C /tmp/git-src --strip-components=1
cd /tmp/git-src
make -j"$(nproc)" NO_TCLTK=1 NO_GETTEXT=1 NO_PERL=1 NO_PYTHON=1 prefix="$PREFIX" all
make NO_TCLTK=1 NO_GETTEXT=1 NO_PERL=1 NO_PYTHON=1 prefix="$PREFIX" install
hash -r 2>/dev/null || true

# ── 4) 验证：版本 + OCR 实际依赖的五个调用 ─────────────────────────────
echo
echo "==================== 验证 ===================="
log "生效的 git: $(command -v git) → $(git --version)"
case "$(command -v git)" in
  "$PREFIX"/*) : ;;
  *) echo "⚠️  注意: PATH 里排在前面的是 $(command -v git)，不是刚装的 $PREFIX/bin/git。"
     echo "    把 $PREFIX/bin 放到 PATH 前面（或重建容器时在 1Panel 配环境变量 PATH=$PREFIX/bin:\$PATH）。" ;;
esac

cd /tmp && rm -rf gitcheck && mkdir gitcheck && cd gitcheck
git init -q .
echo hi > a.txt
git add a.txt
git -c user.email=check@local -c user.name=check commit -qm x

FAIL=0
check() { # 名称 + 命令
  if sh -c "$2" >/dev/null 2>&1; then echo "  ✅ $1"; else echo "  ❌ $1"; FAIL=1; fi
}
check "merge-base --end-of-options" "git merge-base --end-of-options HEAD HEAD"
check "log --end-of-options"          "git log -1 --format=%B --end-of-options HEAD"
check "rev-list --end-of-options"     "git rev-list --parents -n 1 --end-of-options HEAD"
check "show --diff-merges"            "git show --diff-merges=first-parent --end-of-options HEAD"
check "ls-files --others"             "git ls-files --others --exclude-standard"
git grep --max-count 1 -e hi HEAD -- >/dev/null 2>&1 \
  && echo "  ✅ git grep --max-count" \
  || echo "  ⚠️  git grep --max-count 不可用（OCR 有降级处理，不影响）"

echo "=============================================="
if [ "$FAIL" = "0" ]; then
  echo "✅ 全部通过。重启容器使环境完全就绪：docker restart <容器名>"
else
  echo "❌ 有检查未通过，把上面的输出发给管理员排查。"
fi

# ── apt 太慢？把 Debian 源换成国内镜像后再重跑本脚本 ────────────────────
#   . /etc/os-release   # 确认 VERSION_CODENAME=bookworm
#   cp /etc/apt/sources.list /etc/apt/sources.list.bak 2>/dev/null || true
#   echo "deb https://mirrors.aliyun.com/debian bookworm main" > /etc/apt/sources.list
#   echo "deb https://mirrors.aliyun.com/debian-security bookworm-security main" >> /etc/apt/sources.list
#   (1Panel 容器的源可能是 /etc/apt/sources.list.d/*.sources 形式，同样替换域名即可)
