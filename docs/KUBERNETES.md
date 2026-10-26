# DYKIM PORTAL — Kubernetes(Rocky Linux 9) 설치·외부 공개 절차서

> 대상: Rocky Linux 9.x 서버 1대에 **kubeadm**으로 Kubernetes를 설치하고, 지금 Windows PC에서 쓰는 포털과 데이터를 옮겨 **공인 IP(https://공인IP)로 외부에서 접속**하게 하는 절차입니다.
> 배포 파일은 저장소의 `deploy/kubernetes/`에 있고, 서버에서는 root로 실행합니다.

## 0. 구성 한눈에 보기

```
인터넷 사용자 ──https://공인IP(443)──▶ [공유기/방화벽 포트 전달 80·443] ──▶ Rocky 9 서버
                                                                        │
  Kubernetes(kubeadm, 단일 노드, 네트워크 flannel)                         │
  └─ 네임스페이스 dykim-portal                                            │
     └─ 파드 portal (항상 1개)                                             ▼
        ├─ https  : nginx(비 root) — 서버 80·443 포트를 직접 받음(hostPort), 80→443 이동, 자체 서명 인증서
        └─ portal : 포털(Node.js 24) — 파드 안 127.0.0.1:3000에서만 응답
     └─ 저장소(서버 로컬 디스크)
        /srv/dykim-portal/data     DB(portal.sqlite, 첨부파일 포함)
        /srv/dykim-portal/backups  자동 백업(3일·하루 3건 보관)
        /srv/dykim-portal/shared   공유 파일(휴가 현황 엑셀 등)
```

- **파드는 1개만** 실행합니다. 포털은 SQLite 한 파일에 모든 데이터를 저장하므로 여러 개를 동시에 띄우면 안 됩니다(배포 방식 `Recreate`).
- 별도 Ingress 컨트롤러나 이미지 저장소(레지스트리) 없이 Kubernetes 기본 기능만 씁니다. 이미지는 서버에서 `podman`으로 빌드해 containerd에 넣습니다.
- 도메인이 없으므로 공인 인증 기관 인증서를 받을 수 없어 **자체 서명 인증서**를 씁니다. 처음 접속하면 브라우저 경고가 나오며, 사용자 PC에 인증서를 신뢰 등록하면 사라집니다(6절).

## 1. 준비물 확인

| 항목 | 기준 |
|---|---|
| 서버 | Rocky Linux 9.x, CPU 2개 이상, 메모리 4GB 이상(kubeadm 최소 2CPU·2GB), root 권한 |
| 디스크 | `/srv` 여유 **200GB 이상** 권장. DB 약 12GB + 자동 백업 최대 9개(3일×3건) + 여유. 자동 백업은 여유 공간이 DB 크기의 2배보다 작으면 건너뜀 |
| 네트워크 | 서버에서 인터넷 접속(패키지·이미지 다운로드), **공인 IP**, 외부→서버 **TCP 80·443** 허용(공유기·회사 방화벽 포트 전달) |
| 열지 않을 포트 | 6443(Kubernetes API), 10250(kubelet) 등은 외부에 열지 마세요. SSH(22)는 관리용으로만 제한 |
| 기존 PC | 데이터 이전용 최종 백업 1개(약 12GB)를 만들 공간과 서버로 보낼 수단(scp 또는 USB) |

공인 IP가 서버에 직접 붙어 있지 않고 공유기(NAT) 뒤에 있으면, 공유기에서 **80·443 → 서버 사내 IP** 포트 전달을 설정하세요. 사내에서는 공인 IP 대신 사내 IP로 접속할 수 있도록 4단계에서 두 주소를 모두 등록합니다.

## 2. 서버에 포털 소스 가져오기

방법 A — GitHub에서 받기(저장소 접근 권한 필요):

```bash
sudo dnf -y install git
sudo git clone https://github.com/dykim-tech/portal.git /opt/dykim-portal
cd /opt/dykim-portal/deploy/kubernetes
```

방법 B — PC에서 복사: PC의 포털 폴더를 압축(단 `data`, `backups`, `node_modules`, `.env` 제외)해 서버로 보낸 뒤 `/opt/dykim-portal`에 풉니다.

## 3. Kubernetes 설치 (1회)

```bash
cd /opt/dykim-portal/deploy/kubernetes
sudo bash ./00-prepare-node.sh      # 스왑 끄기·커널 설정·SELinux permissive·방화벽·containerd·kubelet/kubeadm/kubectl·podman
sudo bash ./01-init-cluster.sh      # kubeadm init(파드 대역 10.244.0.0/16) + flannel + 단일 노드 설정
```

- Kubernetes 버전은 **실행 시점의 안정 버전**(dl.k8s.io/release/stable.txt)을 읽어 `pkgs.k8s.io` 저장소를 설정합니다. 버전을 고정하려면 `sudo K8S_MINOR=v1.xx bash ./00-prepare-node.sh`.
- SELinux는 kubeadm 설치 안내에 따라 permissive로 바꿉니다.
- firewalld가 켜져 있으면 http·https만 외부에 열고, 파드·서비스 대역(10.244.0.0/16, 10.96.0.0/12)과 cni0·flannel.1은 내부 통신으로 허용합니다.
- 끝나면 `kubectl get nodes`에 노드가 `Ready`로 보여야 합니다.

## 4. 포털 이미지 빌드와 배포

```bash
sudo bash ./02-build-image.sh                         # podman build → containerd로 가져오기(태그=git 커밋)
sudo bash ./03-deploy.sh <공인IP> [사내IP]             # 예: sudo bash ./03-deploy.sh 203.0.113.10 192.168.0.20
```

`03-deploy.sh`가 하는 일:

1. `/srv/dykim-portal/{data,backups,shared}` 폴더를 만들고 포털 실행 계정(uid 1000)에 권한을 줍니다.
2. 입력한 주소들을 담은 자체 서명 인증서(825일)를 `/etc/dykim-portal/tls/`에 만들고, 사용자 배포용 사본을 `/etc/dykim-portal/dykim-portal.crt`에 둡니다.
3. 포털 허용 주소(`APP_ORIGIN=https://공인IP,https://사내IP`)를 설정합니다. **포털은 여기에 등록한 주소로 접속할 때만 저장·수정이 됩니다.** 다른 주소로 접속하면 "요청 출처를 확인할 수 없습니다"가 나오니, 주소가 바뀌면 `03-deploy.sh`를 새 주소로 다시 실행하세요.
4. 배포 파일을 `/etc/dykim-portal/manifests/`에 만들어 적용하고, 준비가 끝날 때까지 기다린 뒤 `https://서버IP/api/health`를 확인합니다.

데이터를 옮기지 않는 새 설치라면 화면에 나온 **첫 관리자 설정 코드**로 관리자 계정을 만듭니다. 기존 데이터를 옮길 때는 5절로 갑니다.

## 5. 기존 PC 데이터 옮기기

PC와 서버를 동시에 쓰면 데이터가 따로 바뀌고 자동으로 합쳐지지 않습니다. **PC 입력 중지 → 최종 백업 → 서버 가져오기 → 확인 → 서버 사용 시작** 순서로 진행하세요.

**① PC(Windows PowerShell)에서 포털을 멈추고 최종 백업**

```powershell
Set-Location 'F:\ChatGPT\DYKIM-PORTAL'
Disable-ScheduledTask -TaskName 'DYKIM Personal Portal'
Stop-ScheduledTask -TaskName 'DYKIM Personal Portal'
npm.cmd run backup
$backup = Get-ChildItem .\backups -Filter 'portal-*.sqlite' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$backup | Select-Object FullName,Length,LastWriteTime
```

**② 서버로 보내기** (Windows 10/11 기본 OpenSSH의 scp, 계정·IP는 실제 값으로)

```powershell
scp $backup.FullName root@<서버IP>:/var/tmp/
```

**③ 서버에서 가져오기**

```bash
sudo bash ./04-import-data.sh /var/tmp/portal-<날짜>.sqlite --check
```

- `--check`는 가져오기 전에 SQLite 무결성 검사를 합니다(12GB 기준 수 분).
- 포털을 잠시 멈추고 DB를 교체한 뒤 다시 시작합니다. 서버에 이미 있던 DB는 지우지 않고 `portal.sqlite.before-import-날짜`로 남깁니다.
- 끝나면 **기존 계정**으로 로그인해 자료·첨부파일·회의록·업무기안 등을 확인하세요. 확인 후 `/var/tmp`의 백업 파일은 안전한 곳에 보관하거나 지웁니다(민감 정보 포함).

## 6. 브라우저 인증서 경고 없애기 (사용자 PC마다 1회)

자체 서명 인증서라 처음 접속하면 "연결이 비공개로 설정되어 있지 않습니다" 경고가 나옵니다. 서버의 `/etc/dykim-portal/dykim-portal.crt`를 받아 사용자 PC에 신뢰 등록하면 경고 없이 접속됩니다.

- Windows: 파일을 두 번 클릭 → **인증서 설치** → **로컬 컴퓨터** → **모든 인증서를 다음 저장소에 저장** → **신뢰할 수 있는 루트 인증 기관** → 마침. 또는 관리자 PowerShell에서 `certutil -addstore -f Root dykim-portal.crt`. 브라우저를 다시 시작합니다.
- 휴대폰: 경고 화면에서 "고급 → 계속"으로 접속하거나, 기기 설정에서 인증서를 설치합니다(기종마다 메뉴가 다름).
- 주의: 이 인증서는 **이 서버 주소에만** 쓰이는 인증서입니다. 다른 곳에서 받은 인증서를 루트에 등록하지 마세요. `03-deploy.sh`를 다른 주소로 다시 실행하면 인증서가 새로 만들어지므로 다시 등록해야 합니다.
- 나중에 도메인을 마련하면 공인 인증서(Let's Encrypt 등)로 바꿔 경고 없이 쓸 수 있습니다. 그때 `/etc/dykim-portal/tls/portal.crt`·`portal.key`를 바꾸고 `03-deploy.sh <도메인>`을 다시 실행합니다.

## 7. 외부 접속 확인

1. 회사 밖 네트워크(예: 휴대폰 LTE)에서 `https://<공인IP>` 접속 → 로그인 화면이 나오면 성공.
2. `http://<공인IP>`로 접속하면 자동으로 https로 이동하는지 확인.
3. 접속이 안 되면: 서버에서 `curl -k https://<서버 사내IP>/api/health` → 되면 공유기·회사 방화벽의 80·443 포트 전달을, 안 되면 `sudo bash ./status.sh`로 파드 상태를 확인합니다.

## 8. 운영

| 작업 | 명령 |
|---|---|
| 상태·최근 로그·디스크·인증서 만료일 | `sudo bash ./status.sh` |
| 포털 업데이트(새 소스) | `sudo bash ./update.sh` (git pull → 이미지 빌드 → 교체) |
| 직전 버전으로 되돌리기 | `sudo kubectl -n dykim-portal rollout undo deployment/portal` |
| 포털 재시작 | `sudo kubectl -n dykim-portal rollout restart deployment/portal` |
| 주소·인증서 변경 | `sudo bash ./03-deploy.sh <새 공인IP> [사내IP]` |
| 실시간 로그 | `sudo kubectl -n dykim-portal logs -f deployment/portal -c portal` |

- **백업**: 포털의 자동 백업은 `/srv/dykim-portal/backups`에 쌓입니다(3일·하루 3건). 서버 디스크 고장에 대비해 이 폴더를 **다른 장비로 정기 복사**하세요. 포털 화면의 백업/복구 기능은 그대로 사용할 수 있습니다.
- **인증서 만료**: 825일. `status.sh`로 만료일을 확인하고, 만료 전에 `/etc/dykim-portal/tls/portal.crt`를 다른 이름으로 옮긴 뒤 `03-deploy.sh`를 다시 실행하면 새로 만들어집니다(사용자 PC 재등록 필요).
- **서버 재부팅**: kubelet·containerd가 자동 시작되고 포털 파드도 다시 뜹니다. 몇 분 뒤 `status.sh`로 확인하세요.
- **DB 오류 자동 복구**: 디스크 I/O 오류가 감지되면 포털이 스스로 종료하고 Kubernetes가 파드를 다시 띄웁니다(`PORTAL_RESTART_ON_DB_FAILURE=true`).

## 9. Windows PC에서와 달라지는 점

| 기능 | 서버(Kubernetes)에서 |
|---|---|
| 휴가 현황(엑셀 연동) | 서버는 PC의 OneDrive 경로(`C:\Users\...`)를 읽을 수 없습니다. 엑셀 파일을 서버 `/srv/dykim-portal/shared/`에 복사하고, 설정 → 휴가 현황 연동의 경로를 `/app/shared/<파일 이름>.xlsm`으로 바꾸세요. **자동 동기화되지 않으므로** 엑셀을 고칠 때마다 다시 복사해야 합니다. |
| Mail(Outlook) 메뉴 | 각 사용자 PC에 설치된 Outlook을 여는 기능이라 그대로 쓸 수 있습니다(각 PC에서 `scripts/windows-outlook-protocol.ps1` 등록 필요). |
| 업무기안 승인 요청 메일 | Outlook 발송 도우미는 Windows PC에서만 동작합니다. 서버에서는 메일이 '발송 대기'로 남으므로 이 기능을 쓰려면 PC의 포털을 계속 쓰거나 별도 발송 방식이 필요합니다. |
| 운영관리 → 점검 로그 | 컨테이너에는 테스트·git이 없어 자동 점검을 끕니다(`PORTAL_SELF_CHECK=off`). |
| Windows 예약 작업 | 이전 후에는 PC의 `DYKIM Personal Portal` 작업을 **사용 안 함**으로 둡니다(5절 ①). |
| 접속 주소 | `http://localhost:3000` 대신 `https://<공인IP>`(사내는 `https://<사내IP>`) |

## 10. 보안 체크리스트 (외부 공개 전)

- 모든 계정에 **강한 비밀번호**를 쓰고, 쓰지 않는 계정은 비활성화합니다(로그인 시도 제한 기능은 실제 접속 IP 기준으로 동작).
- 외부에는 80·443만 열고 6443(Kubernetes API)·SSH는 공개하지 않습니다. SSH는 키 인증과 접속 IP 제한을 권장합니다.
- 서버 OS 업데이트를 정기적으로 적용합니다(`dnf update`, Kubernetes 패키지는 `kubernetes` 저장소 exclude로 고정되어 별도 절차로 업그레이드).
- `/srv/dykim-portal`과 `/etc/dykim-portal/tls`에는 업무 데이터·비밀 키가 있으니 접근 권한을 root로 제한합니다.

## 11. 문제 해결

| 증상 | 확인 |
|---|---|
| 파드가 `Pending` | `kubectl -n dykim-portal describe pod -l app=dykim-portal` — 저장소(PV) 노드 이름, 폴더 존재, 80·443 포트를 다른 프로그램(httpd 등)이 쓰는지 확인 |
| 파드가 `CrashLoopBackOff` | `kubectl -n dykim-portal logs deployment/portal -c portal --previous` — "Production requires HTTPS APP_ORIGIN"이면 03-deploy 주소 확인 |
| `ErrImageNeverPull` | 이미지가 containerd에 없음 → `sudo bash ./02-build-image.sh` 후 `sudo bash ./03-deploy.sh ...` |
| coredns가 준비되지 않음 | firewalld가 파드 통신을 막는 경우 → 3절의 trusted 대역 설정 확인, `firewall-cmd --get-active-zones` |
| 저장 시 "요청 출처를 확인할 수 없습니다" | 접속한 주소가 APP_ORIGIN에 없음 → 그 주소를 포함해 `03-deploy.sh` 재실행 |
| PDF 저장 시 한글 글꼴 오류 | 이미지에 나눔고딕이 포함됨. 직접 만든 이미지라면 Dockerfile의 `fonts-nanum` 설치 확인 |
