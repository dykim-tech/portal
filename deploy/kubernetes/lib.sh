# 공통 설정·함수 (다른 스크립트에서 source)
set -euo pipefail
NAMESPACE=dykim-portal
BASE_DIR=/srv/dykim-portal          # 데이터·백업·공유 파일이 실제로 저장되는 서버 폴더
CONF_DIR=/etc/dykim-portal          # 인증서·설정·배포 파일
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
export KUBECONFIG="${KUBECONFIG:-/etc/kubernetes/admin.conf}"
info() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[주의] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[오류] %s\033[0m\n' "$*" >&2; exit 1; }
need_root() { [ "$(id -u)" -eq 0 ] || die "root 권한으로 실행해 주세요: sudo bash $0 $*"; }
