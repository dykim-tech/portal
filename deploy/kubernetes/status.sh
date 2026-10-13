#!/usr/bin/env bash
# 상태 확인: 노드·파드·최근 로그·디스크·인증서 만료일
source "$(dirname "$0")/lib.sh"
kubectl get nodes -o wide
echo; kubectl -n "$NAMESPACE" get pods -o wide
echo; kubectl -n "$NAMESPACE" logs deployment/portal -c portal --tail=15 2>/dev/null || true
echo; df -h "$BASE_DIR" 2>/dev/null || true
echo; du -sh "$BASE_DIR"/data "$BASE_DIR"/backups 2>/dev/null || true
[ -f "$CONF_DIR/tls/portal.crt" ] && echo && echo "인증서 만료: $(openssl x509 -in "$CONF_DIR/tls/portal.crt" -noout -enddate | cut -d= -f2)"
