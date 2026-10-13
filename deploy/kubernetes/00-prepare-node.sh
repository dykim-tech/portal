#!/usr/bin/env bash
# 1단계: Rocky Linux 9 서버를 Kubernetes(kubeadm) 노드로 준비한다. (root로 1회 실행)
#  - 스왑 끄기, 커널 모듈·네트워크 설정, SELinux permissive(kubeadm 공식 안내), firewalld 규칙
#  - containerd(Docker 공식 저장소의 containerd.io) 설치·systemd cgroup 설정
#  - kubelet·kubeadm·kubectl 설치(pkgs.k8s.io). 버전은 실행 시점의 Kubernetes 안정 버전을 조회해 쓴다.
#    특정 버전을 쓰려면: K8S_MINOR=v1.xx ./00-prepare-node.sh
source "$(dirname "$0")/lib.sh"
need_root

. /etc/os-release
[[ "${ID:-}" == "rocky" && "${VERSION_ID:-}" == 9* ]] || warn "Rocky Linux 9가 아닙니다(${PRETTY_NAME:-알 수 없음}). 계속 진행합니다."

info "Kubernetes 버전 확인"
if [ -z "${K8S_MINOR:-}" ]; then
  STABLE="$(curl -fsSL https://dl.k8s.io/release/stable.txt)" || die "dl.k8s.io에서 안정 버전을 읽지 못했습니다. 인터넷 연결을 확인하거나 K8S_MINOR=v1.xx 로 지정해 주세요."
  K8S_MINOR="$(echo "$STABLE" | sed -E 's/^(v[0-9]+\.[0-9]+).*/\1/')"
fi
[[ "$K8S_MINOR" =~ ^v[0-9]+\.[0-9]+$ ]] || die "K8S_MINOR 형식이 올바르지 않습니다: $K8S_MINOR (예: v1.34)"
echo "사용할 Kubernetes: $K8S_MINOR"

info "스왑 끄기"
swapoff -a
sed -i -E '/^[^#].*\sswap\s/ s/^/# (kubernetes) /' /etc/fstab
if systemctl list-unit-files 2>/dev/null | grep -q '^dev-zram0.swap'; then systemctl mask --now dev-zram0.swap || true; fi

info "커널 모듈·네트워크 설정"
cat > /etc/modules-load.d/k8s.conf <<'CONF'
overlay
br_netfilter
CONF
modprobe overlay
modprobe br_netfilter
cat > /etc/sysctl.d/99-kubernetes.conf <<'CONF'
net.bridge.bridge-nf-call-iptables  = 1
net.bridge.bridge-nf-call-ip6tables = 1
net.ipv4.ip_forward                 = 1
CONF
sysctl --system >/dev/null

info "SELinux permissive (kubeadm 설치 안내에 따름)"
setenforce 0 2>/dev/null || true
sed -i 's/^SELINUX=enforcing$/SELINUX=permissive/' /etc/selinux/config

info "방화벽(firewalld) 규칙"
if systemctl is-active --quiet firewalld; then
  # 외부 공개: 80(HTTP→HTTPS 이동), 443(HTTPS)만. Kubernetes API(6443)는 외부에 열지 않는다.
  firewall-cmd --permanent --add-service=http --add-service=https
  # 파드 네트워크(flannel)와 서비스 주소 대역은 서버 내부 통신으로 허용
  firewall-cmd --permanent --zone=trusted --add-source=10.244.0.0/16 --add-source=10.96.0.0/12
  firewall-cmd --permanent --zone=trusted --add-interface=cni0 --add-interface=flannel.1 || true
  firewall-cmd --reload
else
  warn "firewalld가 꺼져 있습니다. 외부 공개 서버라면 80·443만 열리도록 네트워크 방화벽을 확인해 주세요."
fi

info "containerd 설치"
dnf -y install dnf-plugins-core curl tar openssl
if [ ! -f /etc/yum.repos.d/docker-ce.repo ]; then
  dnf config-manager --add-repo https://download.docker.com/linux/rhel/docker-ce.repo
fi
dnf -y install containerd.io
mkdir -p /etc/containerd
if [ ! -f /etc/containerd/config.toml ] || ! grep -q 'SystemdCgroup' /etc/containerd/config.toml; then
  containerd config default > /etc/containerd/config.toml
fi
sed -i 's/SystemdCgroup = false/SystemdCgroup = true/' /etc/containerd/config.toml
grep -q 'SystemdCgroup = true' /etc/containerd/config.toml || die "containerd 설정에서 SystemdCgroup = true 를 지정하지 못했습니다. /etc/containerd/config.toml 을 확인해 주세요."
systemctl enable --now containerd
systemctl restart containerd

info "kubelet·kubeadm·kubectl 설치 ($K8S_MINOR)"
cat > /etc/yum.repos.d/kubernetes.repo <<CONF
[kubernetes]
name=Kubernetes
baseurl=https://pkgs.k8s.io/core:/stable:/${K8S_MINOR}/rpm/
enabled=1
gpgcheck=1
gpgkey=https://pkgs.k8s.io/core:/stable:/${K8S_MINOR}/rpm/repodata/repomd.xml.key
exclude=kubelet kubeadm kubectl cri-tools kubernetes-cni
CONF
dnf -y install kubelet kubeadm kubectl --disableexcludes=kubernetes
systemctl enable --now kubelet

info "이미지 빌드 도구(podman)·SQLite 도구 설치"
dnf -y install podman sqlite

info "완료. 다음: sudo bash ./01-init-cluster.sh"
