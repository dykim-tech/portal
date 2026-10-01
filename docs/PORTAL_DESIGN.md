# DYKIM PORTAL 설계도

> 기준: 2026-10-01, GitHub main의 설치관리 표 개편 버전. 이 문서는 현재 구현된 동작을 설명합니다.

## 1. 목적과 범위

개인 PC 또는 사내 서버에서 설치 정보, 매뉴얼·자료, 자산, 고객별 업무일지와 기한 알림을 한곳에서 관리하는 웹 포털입니다. 현재 사용 중인 Windows 설치는 사용자 PC에서 Node.js 서버를 백그라운드로 실행하고, 브라우저에서 http://localhost:3000 으로 접속합니다.

## 2. 전체 구성

~~~mermaid
flowchart LR
  U[사용자 브라우저] -->|HTTP, 기본 localhost:3000| S[Node.js / Express 서버]
  S --> DB[(SQLite: portal.sqlite)]
  S --> P[정적 화면: public/]
  S --> B[백업: backups/]
  T[Windows 작업 스케줄러] -->|로그인 시 실행| S
  G[GitHub: 소스 코드와 문서] -->|수동 git pull 및 재시작| S
~~~

- 화면: public/app.js, public/extras.js, public/styles.css. 별도 프런트엔드 빌드 없이 Express가 파일을 제공합니다.
- API·인증: server/app.mjs. 설치·자료는 server/features.mjs, 분류는 server/categories.mjs, 고객·업무일지는 server/work.mjs, 리포트는 server/reports.mjs가 담당합니다.
- 저장소: server/db.mjs가 Node.js 내장 SQLite를 열고 기본 테이블을 만듭니다. 첨부파일도 별도 파일 폴더가 아니라 SQLite의 BLOB 데이터로 저장합니다.
- 실행: server/index.mjs가 HTTP 서버와 1분 간격 기한 확인을 시작합니다. Windows 자동 실행에서는 server/windows-start.mjs가 로그를 파일에 기록하며 index.mjs를 불러옵니다.

## 3. 데이터 저장 위치

현재 Windows 설치의 프로젝트 경로는 F:\ChatGPT\DYKIM-PORTAL 입니다. .env에서 DATA_DIR을 바꾸지 않았다면 실제 저장 위치는 아래와 같습니다.

| 위치 | 저장 내용 | GitHub 전송 |
|---|---|---|
| F:\ChatGPT\DYKIM-PORTAL\data\portal.sqlite | 사용자, 설치·자료·자산·업무일지, 알림, 첨부파일 등 운영 데이터 | 안 함 |
| 같은 data 폴더의 portal.sqlite-wal, portal.sqlite-shm | SQLite 실행 중 만들어질 수 있는 보조 파일 | 안 함 |
| F:\ChatGPT\DYKIM-PORTAL\data\server.log | Windows 백그라운드 서버 실행 기록 | 안 함 |
| F:\ChatGPT\DYKIM-PORTAL\data\setup-token.txt | 최초 관리자 생성 전의 일회용 설정 코드. 생성 후 삭제 | 안 함 |
| F:\ChatGPT\DYKIM-PORTAL\backups\ | npm run backup으로 만든 날짜별 SQLite 백업 | 안 함 |
| 브라우저 localStorage의 portal-theme | 해당 브라우저의 일반/다크 모드 선택 | 안 함 |

포털의 로그인 비밀번호는 원문이 아닌 scrypt 해시로 DB에 저장됩니다. 로그인 세션도 DB에 해시 형태로 저장하고, 브라우저에는 HttpOnly 세션 쿠키를 둡니다. 화면에서 내려받는 CSV는 요청 시 DB에서 만들어지며 별도 운영 파일로 쌓이지 않습니다.

.env가 존재하고 DATA_DIR을 다른 경로로 설정했다면 위 data 경로 대신 그 경로에 portal.sqlite 등이 저장됩니다. 데이터는 Git 저장소의 data/와 backups/ 제외 규칙에 따라 일반적인 git push로 GitHub에 올라가지 않습니다.

## 4. 데이터 모델

~~~mermaid
erDiagram
  users ||--o{ sessions : 로그인
  users ||--o{ items : 등록_수정
  items ||--o{ files : 첨부
  items ||--o{ history : 변경이력
  items ||--o{ notifications : 관리기한
  installations ||--o{ installation_files : 첨부
  folders ||--o{ folders : 하위분류
  folders ||--o{ manuals : 자료
  record_categories ||--o{ record_categories : 하위분류
  customers ||--o{ work_logs : 업무일지
~~~

| 데이터 | 주요 내용 |
|---|---|
| users, sessions, login_attempts | 사용자 권한·로그인·시도 제한 |
| installations, installation_files | 고객사별 설치 현황과 건별 첨부자료 |
| record_categories | 설치와 자산의 대분류→중분류→소분류. scope로 두 영역을 구분 |
| folders, manuals | 자료 관리의 3단계 탐색기 폴더와 업로드 파일 |
| items, files, history, notifications | 자산, 첨부파일, 변경 이력, 관리 기한 알림 |
| customers, work_logs | 고객 목록과 고객별 날짜·제목·담당자·상태·업무 내용 |

설치 기록의 고객사는 installations.customer에 이름으로 저장되며, 같은 이름을 업무관리의 customers 목록에도 추가합니다. 설치 기록 자체가 고객 ID를 참조하는 구조는 아닙니다. 설치 목록의 구분은 저장된 별도 분류값이 아니라 화면의 행 번호입니다. 설치시작일은 필수이고 설치종료일은 진행 중이면 비울 수 있습니다.

## 5. 화면과 주요 흐름

| 메뉴 | 사용자 흐름 |
|---|---|
| 대시보드 | 설치·자료·자산 건수, 최근 설치, 최근 자산, 다가오는 기한 확인 |
| 설치관리 | 3단계 분류 선택 → 고객사·제품명·세부내용·수량·설치시작/종료일·담당자·설치엔지니어·비고 등록 → 검색·상세·첨부 |
| 자료 관리 | 대분류→중분류→소분류 생성 → 소분류에서 파일 업로드 → 검색·미리보기·다운로드 |
| 자산 관리 | 자산 분류 선택 → 일반/IT 자산 등록 → 상태·수량·담당자·관리 기한·첨부·변경 이력 관리 |
| 업무관리 | 고객 등록/선택 → 고객별 업무일지 작성·수정·검색 |
| 리포트 | 기간별 설치·자료·자산·업무 현황 조회 → Excel에서 열 수 있는 UTF-8 CSV 다운로드 |
| 사용자 관리 | 관리자가 계정과 권한 관리 |
| 설정 | 일반/다크 모드 및 비밀번호 변경 |

설치 표의 제품명은 DB의 name, 세부내용은 product_version 필드에 대응합니다. 기존 기록은 삭제하지 않고 수량 기본값 1, 빈 설치종료일·담당자를 추가하는 방식으로 확장했습니다. 기존 상태·설치 위치·분류도 상세 화면에서 계속 관리합니다.

## 6. 권한과 보안

- 관리자: 모든 업무 기능과 사용자 관리.
- 편집자: 설치·자료·자산·고객·업무일지의 등록·수정과 자료 관리.
- 조회자: 조회·검색·다운로드·리포트 확인.
- 서버에서 역할을 검사하며, 쓰기 요청은 설정된 APP_ORIGIN과 요청 헤더를 확인합니다. 세션 쿠키는 HttpOnly·SameSite이며 기본 유효 시간은 12시간입니다.
- 기본 설정은 127.0.0.1:3000에서만 수신합니다. 사내 다른 기기나 인터넷에서 접속시키려면 네트워크·HTTPS·접속 주소를 별도로 구성해야 합니다.

## 7. 파일·알림·운영 제한

- 자료 및 설치·자산 첨부는 파일당 최대 10MB입니다. 설치/자산 한 건의 첨부 합계는 각각 최대 50MB입니다.
- PDF, PNG, JPG, GIF, WebP, 텍스트 파일은 미리보기를 지원합니다. Office/HWP 등은 다운로드하여 확인합니다.
- 자산 관리 기한은 서버 시작 시와 실행 중 매분 한국 시간 기준으로 검사합니다. 알림은 포털 안에 표시되며 이메일·문자 발송은 구현되어 있지 않습니다.
- 현재 구조는 로컬 SQLite를 사용하는 단일 서버·소규모 공유 환경을 대상으로 합니다. PC 전원이 꺼지면 포털에도 접속할 수 없습니다.

## 8. Windows 실행과 백업

scripts/windows-install.ps1은 작업 스케줄러에 DYKIM Personal Portal 작업을 등록합니다. Windows 로그인 시 현재 사용자 권한으로 Node.js를 직접 실행하므로 명령 창을 열어 둘 필요가 없습니다. 작업은 프로젝트 폴더를 작업 디렉터리로 사용하며, 실행 기록은 data/server.log에 남깁니다.

프로젝트 폴더에서 npm run backup을 실행하면 backups/에 portal-날짜.sqlite 형식의 온라인 백업이 생성됩니다. 이 백업에는 계정 정보와 업로드 파일도 포함됩니다. 백업 생성은 현재 수동이며 자동 일정과 외부 보관은 별도로 구성해야 합니다. 복구할 때는 서버를 완전히 중지하고 기존 data 폴더를 별도 보관한 뒤, 선택한 백업을 새 data 폴더의 portal.sqlite로 배치합니다. 과거 WAL/SHM 파일을 복구본과 섞지 않습니다.

## 9. GitHub의 역할과 업데이트 흐름

GitHub 저장소 https://github.com/dykim-tech/portal 은 **설계도와 프로그램 소스의 버전 관리·변경 검토·자동 검사**를 위한 곳입니다. GitHub Actions가 문법 검사, 자동 테스트, 의존성 보안 검사를 수행합니다. GitHub 자체가 현재 PC의 포털 서버를 실행하거나 SQLite 운영 데이터를 실시간 보관하지는 않습니다.

~~~mermaid
flowchart LR
  C[코드·문서 수정] --> R[GitHub 저장소 / 검토]
  R --> A[자동 검사]
  A --> M[main 반영]
  M --> L[PC에서 git pull]
  L --> W[Windows 포털 작업 재설치·재시작]
  W --> P[새 버전 접속]
~~~

일반 사용 중 입력한 데이터는 PC의 SQLite에 즉시 저장됩니다. 코드 업데이트는 git pull과 서버 재시작을 해야 화면에 반영됩니다. .gitignore는 .env, data/, backups/, node_modules/ 및 로그를 제외합니다. 따라서 GitHub만으로는 운영 데이터 복구가 불가능하며 SQLite 백업을 별도로 보관해야 합니다.

Docker로 운영하는 경우에는 PC의 data 폴더 대신 Compose의 portal_data 볼륨에 DB가, portal_backups 볼륨에 백업이 저장됩니다.
