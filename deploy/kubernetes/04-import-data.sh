#!/usr/bin/env bash
# 5단계: 기존 PC 포털의 데이터(백업 파일 1개)를 서버로 옮긴다. (root로 실행)
#   사용법: ./04-import-data.sh <백업 파일.sqlite> [--check]
#   - 백업 파일은 PC 포털의 '백업/복구'에서 만든 portal-YYYY-...sqlite (첨부파일 포함 한 파일)
#   - --check: 가져오기 전에 SQLite 무결성(quick_check)을 검사(12GB 기준 수 분 걸림)
#   - 기존 서버 데이터가 있으면 portal.sqlite.before-import-날짜 로 남겨 둔다(삭제하지 않음).
source "$(dirname "$0")/lib.sh"
need_root
SRC="${1:-}"; CHECK="${2:-}"
[ -n "$SRC" ] && [ -f "$SRC" ] || die "사용법: $0 <백업 파일.sqlite> [--check]"
[ "$(head -c 15 "$SRC")" = "SQLite format 3" ] || die "SQLite 데이터베이스 파일이 아닙니다: $SRC"
# 포털 백업은 단독 파일(journal_mode=DELETE)이다. WAL 모드 파일이면 -wal 파일이 함께 있어야 한다.
WAL_BYTE="$(od -An -tu1 -j18 -N1 "$SRC" | tr -d ' ')"
[ "$WAL_BYTE" = "1" ] || warn "WAL 모드로 저장된 파일입니다. 포털의 '백업/복구'에서 만든 백업 파일을 쓰는 것이 안전합니다."
if [ "$CHECK" = "--check" ]; then
  info "무결성 검사(quick_check) — 시간이 걸립니다"
  RESULT="$(sqlite3 -readonly "$SRC" 'PRAGMA quick_check;')"
  [ "$RESULT" = "ok" ] || die "무결성 검사 실패: $(echo "$RESULT" | head -c 500)"
  echo "ok"
fi
FREE_KB="$(df -Pk "$BASE_DIR/data" | awk 'NR==2{print $4}')"; SIZE_KB="$(( $(stat -c %s "$SRC") / 1024 ))"
[ "$FREE_KB" -gt "$(( SIZE_KB + 1048576 ))" ] || die "$BASE_DIR/data 여유 공간이 부족합니다(필요: 약 $(( SIZE_KB/1024/1024 + 1 ))GB)."

info "포털 잠시 중지"
kubectl -n "$NAMESPACE" scale deployment/portal --replicas=0
kubectl -n "$NAMESPACE" wait --for=delete pod -l app=dykim-portal --timeout=180s 2>/dev/null || true

info "데이터 교체"
STAMP="$(date +%Y%m%d%H%M%S)"
cd "$BASE_DIR/data"
if [ -f portal.sqlite ]; then
  mv portal.sqlite "portal.sqlite.before-import-$STAMP"
  for ext in -wal -shm; do [ -f "portal.sqlite$ext" ] && mv "portal.sqlite$ext" "portal.sqlite$ext.before-import-$STAMP"; done
  echo "기존 데이터 보관: $BASE_DIR/data/portal.sqlite.before-import-$STAMP"
fi
cp "$SRC" portal.sqlite.importing
mv portal.sqlite.importing portal.sqlite
chown 1000:1000 portal.sqlite; chmod 600 portal.sqlite
rm -f setup-token.txt

info "포털 다시 시작"
kubectl -n "$NAMESPACE" scale deployment/portal --replicas=1
kubectl -n "$NAMESPACE" rollout status deployment/portal --timeout=900s
kubectl -n "$NAMESPACE" logs deployment/portal -c portal --tail=5 || true
info "완료. 기존 계정으로 로그인해 데이터를 확인해 주세요."
