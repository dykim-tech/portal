# DYKIM PORTAL 운영 절차 및 장애 대응

> 적용 대상: F:\ChatGPT\DYKIM-PORTAL 에 설치한 Windows PC 버전 (2026-10-01 기준). Docker 운영 절차는 이 문서의 대상이 아닙니다.

## 1. 운영 구성과 핵심 위치

| 항목 | 현재 구성 |
|---|---|
| 접속 주소 | http://localhost:3000 |
| 자동 실행 | Windows 작업 스케줄러의 DYKIM Personal Portal 작업. 해당 Windows 사용자가 로그인할 때 실행 |
| 서버 | Node.js가 server/windows-start.mjs → server/index.mjs를 실행 |
| 운영 데이터 | F:\ChatGPT\DYKIM-PORTAL\data\portal.sqlite |
| 실행 로그 | F:\ChatGPT\DYKIM-PORTAL\data\server.log |
| 수동 백업 | F:\ChatGPT\DYKIM-PORTAL\backups\portal-날짜.sqlite |
| 설정 | 프로젝트 폴더의 .env (없으면 코드의 기본값 사용) |

PC가 꺼져 있거나 해당 사용자가 로그인하지 않아 작업이 시작되지 않았다면 포털에 접속할 수 없습니다. GitHub 접속 장애는 이미 설치된 포털의 실행에는 영향을 주지 않지만 코드 업데이트는 할 수 없습니다. data/와 backups/는 GitHub에 저장되지 않습니다.

## 2. 평상시 기동 및 확인

1. Windows에 로그인합니다. DYKIM Personal Portal 예약 작업이 서버를 자동으로 시작합니다. PowerShell 창을 열어 둘 필요는 없습니다.
2. 브라우저에서 http://localhost:3000 에 접속해 로그인합니다.
3. 접속이 안 되면 아래 명령으로 작업 상태와 서버 응답을 확인합니다.

~~~powershell
Get-ScheduledTask -TaskName 'DYKIM Personal Portal' | Select-Object TaskName,State
Get-ScheduledTaskInfo -TaskName 'DYKIM Personal Portal' | Select-Object LastRunTime,LastTaskResult
Invoke-RestMethod 'http://127.0.0.1:3000/api/health'
~~~

정상일 때 작업은 Running 상태이고, health 응답에는 ok: true가 표시됩니다. health가 성공해도 화면이 오래된 것처럼 보이면 브라우저를 강력 새로고침(Ctrl+F5)합니다.

## 3. 수동 시작과 재시작

예약 작업이 Ready 또는 중지 상태일 때 수동으로 시작합니다.

~~~powershell
Start-ScheduledTask -TaskName 'DYKIM Personal Portal'
Start-Sleep -Seconds 3
Invoke-RestMethod 'http://127.0.0.1:3000/api/health'
~~~

서버가 응답하지 않거나 코드 업데이트 후 재시작이 필요하면 다음 순서로 진행합니다.

~~~powershell
Stop-ScheduledTask -TaskName 'DYKIM Personal Portal'
Start-Sleep -Seconds 3
Start-ScheduledTask -TaskName 'DYKIM Personal Portal'
Start-Sleep -Seconds 3
Invoke-RestMethod 'http://127.0.0.1:3000/api/health'
~~~

작업 자체가 없거나 구성이 손상된 경우 프로젝트 폴더에서 설치 스크립트를 다시 실행합니다. 이 스크립트는 기존 작업과 포트 점유 상태를 확인한 뒤 작업을 등록·시작하고 health를 검사합니다.

~~~powershell
Set-Location 'F:\ChatGPT\DYKIM-PORTAL'
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File '.\scripts\windows-install.ps1'
~~~

## 4. 장애별 처리

### A. 브라우저에 연결할 수 없음

1. PC 전원과 Windows 로그인 상태를 확인합니다.
2. 2절의 작업 상태와 health 응답을 확인합니다.
3. 작업이 멈춰 있으면 3절의 수동 시작을 실행합니다.
4. 여전히 실패하면 아래 로그의 마지막 부분을 확인합니다.

~~~powershell
Get-Content 'F:\ChatGPT\DYKIM-PORTAL\data\server.log' -Tail 50
~~~

로그가 비어 있거나 없으면 작업 스케줄러의 마지막 실행 결과, Node.js 설치 상태, 프로젝트 경로를 확인합니다. 필요한 의존성이 없다는 메시지가 있으면 프로젝트 폴더에서 npm ci를 실행한 뒤 설치 스크립트를 다시 실행합니다.

### B. 포트 3000이 이미 사용 중

설치 스크립트가 포트 충돌을 보고하면 프로세스를 먼저 식별합니다.

~~~powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen | Select-Object LocalAddress,LocalPort,OwningProcess
~~~

표시된 OwningProcess 번호로 다음 명령을 실행해 이름·실행 경로·명령줄을 확인합니다. 아래의 숫자 12345는 실제 번호로 바꿉니다.

~~~powershell
Get-CimInstance Win32_Process -Filter 'ProcessId = 12345' |
  Select-Object ProcessId,Name,ExecutablePath,CommandLine,ParentProcessId | Format-List
~~~

server/index.mjs 또는 server/windows-start.mjs를 실행하는 이 포털의 node.exe임이 확인될 때에만 해당 프로세스를 종료하고 설치 스크립트를 다시 실행합니다. 다른 프로그램이면 임의로 종료하지 말고 그 프로그램의 포트 설정을 확인합니다.

### C. 작업은 실행 중인데 화면이 오류를 표시함

1. health가 ok: true인지 확인합니다.
2. 브라우저에서 Ctrl+F5로 새로고침하고 다시 로그인합니다.
3. 기능 호출이 없다는 오류가 계속되면 이전 Node 프로세스가 남았을 수 있으므로 3절의 재시작과 4-B절의 포트 점검을 진행합니다.
4. data/server.log의 오류와 발생 시각을 확인합니다.

### D. 로그인 실패 또는 자료가 갑자기 비어 보임

비밀번호·계정을 확인하고, 관리자가 사용자 관리에서 계정 상태를 확인합니다. 최초 설정 화면이 다시 나타나거나 모든 자료가 비어 보이면 **새 관리자 계정을 만들거나 새 자료를 등록하기 전에** 서버가 기존 DB를 사용 중인지 확인합니다. .env의 DATA_DIR 설정과 F:\ChatGPT\DYKIM-PORTAL\data\portal.sqlite 존재 여부를 확인하고, 기존 데이터 폴더를 보존합니다. 같은 PC의 기존 DB를 찾지 못하면 6절의 백업을 확인합니다.

### E. 파일 등록 실패

편집 권한과 디스크 여유 공간을 확인합니다. 파일당 제한은 500MB이며 기존 설치·자산 건당 50MB 합계 제한은 없습니다. 큰 파일을 올릴 때는 `data/upload-tmp/`와 SQLite/WAL에 충분한 디스크 여유 공간이 필요한지 확인합니다. 오류가 지속되면 로그와 해당 화면의 오류 문구를 함께 확인합니다.

## 5. 업데이트 절차

1. 먼저 6절의 수동 백업을 만들고 백업 파일이 생겼는지 확인합니다.
2. 예약 작업을 중지합니다.
3. 프로젝트 폴더에서 git pull --ff-only를 실행합니다. 충돌이나 로컬 변경 오류가 나면 파일을 덮어쓰거나 초기화하지 말고 원인을 확인합니다.
4. package-lock.json이 변경되었거나 의존성이 없으면 npm ci를 실행합니다.
5. scripts/windows-install.ps1을 실행해 작업을 재등록·시작합니다.
6. health와 주요 화면을 확인합니다.

GitHub에서 코드를 갱신해도 실행 중인 서버는 자동으로 새 버전으로 바뀌지 않습니다. 데이터 파일과 .env는 Git 업데이트 대상이 아닙니다.

## 6. 백업과 복구

관리자는 포털의 **백업/복구** 메뉴에서 **지금 백업**으로 온라인 백업을 만들고, 저장된 백업의 날짜·크기를 확인한 뒤 다운로드할 수 있습니다. **복구**에서는 저장된 백업 중 시점을 선택합니다. 복구 직전 상태는 `portal-pre-restore-*.sqlite`로 남고, 포털이 같은 주소로 다시 열리면 완료됩니다. 복구 전후에 사용자 계정·자료 건수를 확인하세요. 백업 파일이 크면 복구에도 시간이 걸리며, 다운로드한 사본은 다른 디스크에 보관하는 편이 안전합니다.

화면 복구는 백업 무결성과 포털 구조를 확인합니다. 고객·업무일지 기능 이전의 확인된 초기 백업도 원본을 보존하면서 임시 사본을 현재 형식으로 이전·검사한 뒤 복구합니다. 필수 기본 테이블이나 열이 빠진 파일, 무결성 검사에 실패한 파일은 적용하지 않습니다. 복구가 실패하면 기존 DB를 유지하거나 되돌리고, 포털이 다시 열리면 기존 자료 건수를 확인하세요. 화면에서 지원하지 않는 다른 형식의 파일은 아래 수동 절차를 검토하되, 현재 포털의 데이터와 이전 백업을 혼합하지 마세요. `.env`에서 `BACKUP_DIR`을 지정했다면 그 위치에 백업이 저장됩니다.

### 백업 만들기

프로젝트 폴더에서 아래 명령을 실행합니다. 실행 중인 SQLite를 위한 온라인 백업 기능을 사용하므로 평상시에도 백업할 수 있습니다.

~~~powershell
Set-Location 'F:\ChatGPT\DYKIM-PORTAL'
npm.cmd run backup
Get-ChildItem '.\backups\portal-*.sqlite' |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 3 Name,Length,LastWriteTime
~~~

백업은 현재 수동입니다. 정기 실행 일정과 다른 디스크·외부 보관은 별도 설정이 필요합니다. 파일에는 계정 정보와 첨부자료가 포함되므로 접근을 제한합니다. 백업 파일을 실제로 열어 복구되는지 주기적으로 시험해야 백업 완료를 확인할 수 있습니다. 실행 중인 portal.sqlite만 일반 파일 복사로 대체하지 않습니다.

### 백업에서 복구

1. 복구할 백업 파일의 날짜를 확인하고, 예약 작업을 중지합니다. 포트 3000을 사용하는 포털 Node 프로세스가 남아 있지 않은지 확인합니다.
2. 현재 data 폴더 전체를 별도 이름으로 보존합니다. 문제가 생겨도 기존 DB와 WAL/SHM 파일을 되돌릴 수 있어야 합니다.
3. 새 data 폴더에 **선택한 백업 파일 하나를 portal.sqlite라는 이름으로** 배치합니다. 예전 portal.sqlite-wal·portal.sqlite-shm을 새 복구본과 섞지 않습니다.
4. 예약 작업을 시작하고 health, 로그인, 설치·자료·자산 건수를 확인합니다.
5. 예상과 다르면 즉시 중지하고 보존해 둔 기존 data 폴더를 사용해 원상 복구합니다.

복구는 기존 데이터를 백업 시점의 상태로 되돌립니다. 마지막 백업 이후의 입력은 사라질 수 있으므로 복구 전에 사용자와 시점을 확인합니다. .env에 별도 DATA_DIR이 설정되어 있다면 그 경로를 기준으로 진행합니다.

## 7. 장애 보고 시 남길 정보

- 장애 발생 시각과 화면에 표시된 오류 문구
- 예약 작업의 State, LastRunTime, LastTaskResult
- /api/health의 응답 여부
- data/server.log 마지막 50줄
- 포트 3000 점유 프로세스의 이름과 명령줄

비밀번호, 초기 설정 코드, DB 원본이나 백업 파일은 일반 채팅·공개 GitHub 이슈에 올리지 않습니다.

## 참고

- [포털 설계도](PORTAL_DESIGN.md)
- [Microsoft 작업 스케줄러 명령](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/)
- [Node.js SQLite 백업](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)
- [SQLite 온라인 백업 방식](https://www.sqlite.org/backup.html)
