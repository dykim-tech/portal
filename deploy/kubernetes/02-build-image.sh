#!/usr/bin/env bash
# 3단계: 포털 컨테이너 이미지를 이 서버에서 빌드해 Kubernetes(containerd)에 넣는다. (root로 실행)
#  레지스트리 없이 podman build → 이미지 파일 → containerd(k8s.io) 가져오기
#  업데이트 때도 같은 스크립트를 쓴다(새 태그로 빌드).
source "$(dirname "$0")/lib.sh"
need_root
cd "$REPO_DIR"
[ -f Dockerfile ] && [ -f package.json ] || die "포털 소스 폴더에서 실행해 주세요($REPO_DIR)."

TAG="${TAG:-$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)}"
IMAGE="localhost/dykim-portal:$TAG"
info "이미지 빌드: $IMAGE"
podman build -t "$IMAGE" .

info "Kubernetes(containerd)로 이미지 가져오기"
ARCHIVE="$(mktemp /var/tmp/dykim-portal-XXXXXX.tar)"
trap 'rm -f "$ARCHIVE"' EXIT
podman save -o "$ARCHIVE" "$IMAGE"
ctr -n k8s.io images import "$ARCHIVE"
ctr -n k8s.io images ls -q | grep "dykim-portal:$TAG" >/dev/null || die "containerd에서 $IMAGE 를 찾지 못했습니다."

mkdir -p "$CONF_DIR"
echo "$IMAGE" > "$CONF_DIR/image"
info "완료: $IMAGE (기록: $CONF_DIR/image). 처음이면 sudo bash ./03-deploy.sh <공인IP>, 업데이트면 sudo bash ./update.sh"
