#!/usr/bin/env bash
# 2단계: 단일 노드 Kubernetes 클러스터 만들기 (root로 1회 실행)
#  - kubeadm init (파드 대역 10.244.0.0/16), 이 서버에서도 파드가 실행되도록 control-plane taint 해제
#  - 네트워크(CNI): flannel 최신 릴리스
source "$(dirname "$0")/lib.sh"
need_root

if [ -f /etc/kubernetes/admin.conf ]; then
  warn "이미 클러스터가 만들어져 있습니다(/etc/kubernetes/admin.conf). kubeadm init 을 건너뜁니다."
else
  info "kubeadm init"
  NODE_IP="${NODE_IP:-$(ip -4 route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')}"
  echo "API 서버 주소(서버 내부 IP): $NODE_IP"
  kubeadm init --pod-network-cidr=10.244.0.0/16 --apiserver-advertise-address="$NODE_IP"
fi

info "관리자 kubectl 설정 (root)"
mkdir -p /root/.kube
cp -f /etc/kubernetes/admin.conf /root/.kube/config
chmod 600 /root/.kube/config

info "단일 노드: 이 서버에서도 일반 파드 실행 허용"
kubectl taint nodes --all node-role.kubernetes.io/control-plane- 2>/dev/null || true

info "네트워크(flannel) 설치"
kubectl apply -f https://github.com/flannel-io/flannel/releases/latest/download/kube-flannel.yml

info "노드 준비 대기"
kubectl wait --for=condition=Ready node --all --timeout=600s
kubectl -n kube-system rollout status deployment/coredns --timeout=300s
kubectl get nodes -o wide
info "완료. 다음: sudo bash ./02-build-image.sh"
