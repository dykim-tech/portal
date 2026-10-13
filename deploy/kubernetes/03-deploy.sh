#!/usr/bin/env bash
# 4단계: 포털 배포 (root로 실행). 주소가 바뀌거나 설정을 고칠 때도 다시 실행하면 된다.
#   사용법: ./03-deploy.sh <공인 IP> [사내에서 쓰는 주소 ...]
#   예)     ./03-deploy.sh 203.0.113.10 192.168.0.20
#  - 접속 주소마다 https://주소 를 포털 허용 주소(APP_ORIGIN)와 인증서(SAN)에 넣는다.
#  - 도메인이 없으므로 자체 서명 인증서를 만든다(브라우저 경고 → 절차서의 '인증서 신뢰 등록' 참고).
source "$(dirname "$0")/lib.sh"
need_root
[ $# -ge 1 ] || die "사용법: $0 <공인 IP> [사내 주소 ...]"
ADDRESSES=("$@")
IMAGE="${IMAGE:-$(cat "$CONF_DIR/image" 2>/dev/null || true)}"
[ -n "$IMAGE" ] || die "포털 이미지가 없습니다. 먼저 ./02-build-image.sh 를 실행해 주세요."

ORIGINS=""; SAN=""
for address in "${ADDRESSES[@]}"; do
  [[ "$address" =~ ^[A-Za-z0-9.:-]+$ ]] || die "주소 형식이 올바르지 않습니다: $address"
  ORIGINS+="${ORIGINS:+,}https://$address"
  if [[ "$address" =~ ^[0-9.]+$ || "$address" == *:* ]]; then SAN+="${SAN:+,}IP:$address"; else SAN+="${SAN:+,}DNS:$address"; fi
done
NODE_NAME="$(kubectl get nodes -o jsonpath='{.items[0].metadata.name}')"
[ -n "$NODE_NAME" ] || die "Kubernetes 노드를 찾지 못했습니다. ./01-init-cluster.sh 를 먼저 실행해 주세요."
echo "접속 주소: $ORIGINS"
echo "노드: $NODE_NAME / 이미지: $IMAGE"

info "저장 폴더 준비 ($BASE_DIR)"
for dir in data backups shared; do mkdir -p "$BASE_DIR/$dir"; done
chown -R 1000:1000 "$BASE_DIR"/{data,backups,shared}
chmod 750 "$BASE_DIR"/{data,backups,shared}

info "HTTPS 인증서"
mkdir -p "$CONF_DIR/tls"; chmod 700 "$CONF_DIR/tls"
CRT="$CONF_DIR/tls/portal.crt" KEY="$CONF_DIR/tls/portal.key"
CURRENT_SAN="$( [ -f "$CRT" ] && openssl x509 -in "$CRT" -noout -ext subjectAltName 2>/dev/null | tail -n +2 | tr -d ' ' | sed 's/IPAddress:/IP:/g' || true)"
if [ ! -f "$CRT" ] || [ "$CURRENT_SAN" != "$SAN" ]; then
  [ -f "$CRT" ] && mv "$CRT" "$CRT.$(date +%Y%m%d%H%M%S)" && mv "$KEY" "$KEY.$(date +%Y%m%d%H%M%S)"
  openssl req -x509 -newkey rsa:2048 -nodes -days 825 -keyout "$KEY" -out "$CRT" \
    -subj "/CN=DYKIM PORTAL/O=GRACECNS" -addext "subjectAltName=$SAN" -addext "extendedKeyUsage=serverAuth" >/dev/null 2>&1
  chmod 600 "$KEY"
  echo "새 인증서를 만들었습니다($SAN). 사용자 PC에 다시 신뢰 등록이 필요합니다: $CRT"
else
  echo "기존 인증서를 그대로 씁니다($SAN, 만료: $(openssl x509 -in "$CRT" -noout -enddate | cut -d= -f2))"
fi
cp -f "$CRT" "$CONF_DIR/dykim-portal.crt"; chmod 644 "$CONF_DIR/dykim-portal.crt"

info "배포 파일 만들기 ($CONF_DIR/manifests)"
mkdir -p "$CONF_DIR/manifests"
for file in "$SCRIPT_DIR"/manifests/*.yaml; do
  sed -e "s|__NODE_NAME__|$NODE_NAME|g" -e "s|__APP_ORIGIN__|$ORIGINS|g" -e "s|__IMAGE__|$IMAGE|g" "$file" > "$CONF_DIR/manifests/$(basename "$file")"
done
! grep -l '__[A-Z_]*__' "$CONF_DIR"/manifests/*.yaml || die "배포 파일에 채워지지 않은 값이 있습니다."

info "Kubernetes에 적용"
EXISTED="$(kubectl -n "$NAMESPACE" get deployment portal -o name 2>/dev/null || true)"
kubectl apply -f "$CONF_DIR/manifests/namespace.yaml"
kubectl -n "$NAMESPACE" create secret tls portal-tls --cert="$CRT" --key="$KEY" --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f "$CONF_DIR/manifests/storage.yaml" -f "$CONF_DIR/manifests/config.yaml" -f "$CONF_DIR/manifests/portal.yaml"
# 설정·인증서 변경을 반영하려면 파드를 다시 띄운다(이미 실행 중이었던 경우).
[ -n "$EXISTED" ] && kubectl -n "$NAMESPACE" rollout restart deployment/portal
kubectl -n "$NAMESPACE" rollout status deployment/portal --timeout=900s

info "접속 확인"
NODE_IP="$(kubectl get node "$NODE_NAME" -o jsonpath='{.status.addresses[?(@.type=="InternalIP")].address}')"
curl -fsk --max-time 10 "https://$NODE_IP/api/health" && echo || warn "https://$NODE_IP/api/health 응답이 없습니다. 'kubectl -n $NAMESPACE logs deploy/portal -c portal' 로 확인해 주세요."
echo
echo "포털 주소:"; for address in "${ADDRESSES[@]}"; do echo "  https://$address"; done
echo "인증서(사용자 PC 신뢰 등록용): $CONF_DIR/dykim-portal.crt"
[ -f "$BASE_DIR/data/setup-token.txt" ] && echo "첫 관리자 설정 코드: $(cat "$BASE_DIR/data/setup-token.txt") (데이터를 옮길 예정이면 ./04-import-data.sh 먼저)"
