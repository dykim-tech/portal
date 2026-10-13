#!/usr/bin/env bash
# 업데이트: 새 소스로 이미지를 빌드하고 포털을 교체한다. (root로 실행)
#   사용법: ./update.sh            (소스 폴더가 git 저장소면 먼저 git pull)
#   되돌리기: kubectl -n dykim-portal rollout undo deployment/portal
source "$(dirname "$0")/lib.sh"
need_root
if [ -d "$REPO_DIR/.git" ] && [ "${SKIP_PULL:-}" != "1" ]; then info "소스 받기 (git pull)"; git -C "$REPO_DIR" pull --ff-only; fi
bash "$SCRIPT_DIR/02-build-image.sh"
IMAGE="$(cat "$CONF_DIR/image")"
info "포털 교체: $IMAGE"
kubectl -n "$NAMESPACE" set image deployment/portal portal="$IMAGE"
kubectl -n "$NAMESPACE" rollout status deployment/portal --timeout=900s
info "완료. 이전 버전으로 되돌리려면: kubectl -n $NAMESPACE rollout undo deployment/portal"
