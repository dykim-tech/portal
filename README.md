# DYKIM PORTAL

개인 PC 또는 사내 서버에서 운영하는 설치·자료·자산 통합 포털입니다. Node.js 24와 SQLite로 동작합니다.

## 메뉴와 기능

| 메뉴 | 기능 |
|---|---|
| 대시보드 | 설치·자료·자산 수, 최근 업데이트, 7일 이내 및 경과한 관리 기한 |
| 설치관리 | 설치명·고객/사업장·위치·설치일·담당자·제품/버전·상태·메모 등록/수정, 검색·날짜/상태 필터 |
| 자료 관리 | 폴더 트리·경로·파일 목록의 탐색기형 화면, 폴더 생성, 매뉴얼 등록·검색·다운로드·미리보기 |
| 자산 관리 | 일반 비품·IT 장비 등록/수정, 관리번호·시리얼·수량·담당자·위치, 첨부자료, 변경 이력, 검색·분류·상태·수정일 필터 |
| 사용자 관리 | 관리자·편집자·조회자, 사용자 추가·수정·비활성화·비밀번호 재설정 |
| 설정 | 일반 모드·다크 모드, 내 비밀번호 변경 |

상단의 **기한 알림**에서 예정·당일·경과 알림과 읽음 상태를 관리합니다. 관리자만 사용자 관리 메뉴에 접근할 수 있습니다. 모든 활성 사용자는 동일한 설치·자료·자산 목록을 공유합니다.

## 개인 PC에서 실행

Node.js **24.13 이상 24.x**가 필요합니다.

```powershell
git clone https://github.com/dykim-tech/portal.git
cd portal
npm ci
Copy-Item .env.example .env
npm start
```

[http://localhost:3000](http://localhost:3000)에 접속합니다. 최초 실행 시 **첫 관리자 만들기** 화면에 아래 코드와 관리자 이름, 이메일, 비밀번호(12자 이상)를 입력합니다.

```powershell
Get-Content .\data\setup-token.txt
```

Linux는 `cat data/setup-token.txt`를 사용합니다. 코드 파일은 관리자 생성 후 자동 삭제됩니다. 기본 계정·공유 비밀번호는 없습니다. 기존 사용자는 관리자가 사용자 관리 메뉴에서 추가합니다.

접속 주소는 `.env`의 `APP_ORIGIN`과 정확히 같아야 합니다. 예를 들어 localhost 대신 127.0.0.1로 접속하면 쓰기 요청이 차단됩니다. 명령 창을 닫거나 PC를 종료하면 포털도 중지됩니다.

## 자료 관리와 미리보기

- 전체 자료 또는 원하는 폴더를 선택하고 **새 폴더**, **자료 등록**을 사용합니다.
- 파일명 클릭 시 미리보기를 엽니다. 현재 폴더 내 이름 검색과 파일 50개 단위 페이지 이동을 지원합니다.
- PDF, PNG, JPG, GIF, WebP, UTF-8 텍스트(TXT/MD/CSV/LOG)를 미리 볼 수 있습니다.
- DOCX/XLSX/PPTX/HWP 등은 다운로드하여 해당 프로그램에서 엽니다. 브라우저가 PDF 미리보기를 지원하지 않을 때도 다운로드를 사용하세요.
- 파일당 최대 10MB입니다. 자산별 첨부자료는 합계 50MB 제한이 추가됩니다.
- 비어 있는 폴더만 삭제할 수 있습니다. 폴더는 8단계까지 지원합니다.
- 파일 이름을 바꾸거나 이동하는 기능, Office/HWP 변환 미리보기는 현재 범위에 포함하지 않습니다.

## 기한 알림

자산의 **관리 기한**에 점검·보증·반납 등 필요한 날짜를 지정합니다. **사전 알림**이 7이면 7일 전부터, 0이면 당일부터 알립니다.

서버 실행 중 매분 한국 표준시 기준으로 확인합니다. 사전/당일/경과 단계별로 자산·기한·사용자당 한 번 생성되어 중복을 막습니다. 서버가 꺼진 동안의 기한은 다음 실행 시 현재 상태로 확인합니다. 기한 변경/해제 또는 사용 종료 시 기존 알림은 제거됩니다. 알림은 포털 내부에 제공되며 이메일·문자·브라우저 푸시는 포함하지 않습니다.

## 권한과 로그인

- 관리자: 사용자·설치·자료·자산 관리
- 편집자: 설치·자료·자산 등록/수정, 자료 삭제
- 조회자: 열람·검색·다운로드·알림 확인

12시간 세션, HttpOnly/SameSite 쿠키, 서버 권한 검사, 출처 검사, 로그인 시도 제한, scrypt 비밀번호 해시를 사용합니다. 비밀번호/권한 변경 또는 비활성화 시 기존 로그인은 해제됩니다. 관리자는 본인의 관리자 권한을 해제하거나 자신을 비활성화할 수 없습니다. 자산·설치 동시 수정 충돌은 덮어쓰지 않고 최신 자료 재확인을 안내합니다.

## Docker

```sh
docker compose up -d --build
docker compose exec portal cat /app/data/setup-token.txt
```

localhost:3000에 열리며 계정과 모든 자료는 `portal_data` 볼륨, 백업은 `portal_backups` 볼륨에 저장됩니다. `docker compose down -v`는 데이터 볼륨을 삭제하므로 사용하지 마세요.

## 사내 서버 운영

HTTPS 역방향 프록시(Caddy 등)를 사용하고 `deploy/Caddyfile.example`의 도메인을 수정하세요. 아래 값을 `.env`에 설정합니다.

```dotenv
HOST=127.0.0.1
PORT=3000
APP_ORIGIN=https://portal.example.com
COOKIE_SECURE=true
TRUST_PROXY=true
NODE_ENV=production
DATA_DIR=./data
```

`TRUST_PROXY=true`는 직접 관리하는 단일 프록시 뒤에서만 사용합니다. 실제 도메인과 HTTPS 인증서를 준비하고 외부 포트는 프록시에만 열어 주세요. Docker는 내부 HOST=0.0.0.0을 유지하며 호스트 포트는 127.0.0.1에 연결합니다. 변경 후 `docker compose up -d --build`로 적용합니다.

Linux 서비스 예시는 `deploy/portal.service`입니다. 전용 portal 계정, `/opt/portal` 설치 경로, 쓰기 가능한 data/backups 폴더를 먼저 준비하고 Node 경로를 확인하세요. Windows 상시 운영은 조직의 Windows 서비스 운영 방식이나 Docker 재시작 정책을 적용하세요. 방화벽·DNS·인증서·자동 시작 설정은 이 코드가 자동 변경하지 않습니다.

## 백업과 복구

```sh
npm run backup
# Docker
docker compose exec portal npm run backup
```

실행 중에도 SQLite 온라인 백업으로 계정·자산·설치·자료·이력을 `backups/`의 단일 파일로 저장합니다. 파일에는 업무자료와 계정 해시가 포함되므로 안전한 별도 저장소에 복사하고 접근을 제한하세요.

복구는 서버를 완전히 중지한 뒤 현재 data 폴더를 별도로 보관하고 새 data 폴더에 백업 파일을 `portal.sqlite`로 넣습니다. 과거 `portal.sqlite-wal`, `portal.sqlite-shm`과 백업 파일을 섞지 마세요. 재시작 후 기존 계정으로 로그인할 수 있습니다.

## 검사·업데이트·GitHub

```sh
npm run check
npm test
npm audit --omit=dev
```

테스트는 운영 데이터와 분리한 임시 DB를 사용합니다. GitHub Actions에서도 같은 검사를 실행합니다. 업데이트는 백업 → 서버 중지 → `git pull --ff-only` → `npm ci` → 검사 → 재시작 순서입니다.

`.env`, `data/`, `backups/`, `work/`, `node_modules/`는 Git에서 제외됩니다. 자료와 계정은 GitHub에 전송하지 않습니다. 일반/다크 모드만 브라우저 localStorage에 저장하고 나머지 업무자료는 서버 DB에 보관합니다.

단일 서버·소규모 공유 환경용입니다. SQLite 파일은 로컬 디스크에 보관하세요. 다중 서버 운영, 그룹별 자료 분리, 자동 이메일 비밀번호 복구, 다중 인증은 현재 포함하지 않습니다.
