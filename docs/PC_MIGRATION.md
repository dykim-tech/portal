# DYKIM PORTAL을 다른 PC로 이전하기

> 대상: 현재 Windows PC에서 `DYKIM Personal Portal` 예약 작업으로 실행하는 로컬 포털. 실제 이전하는 날에 아래 절차를 진행하세요. 경로와 백업 파일명은 예시입니다.

## 먼저 알아둘 점

포털 프로그램은 [GitHub 저장소](https://github.com/dykim-tech/portal)에서 새 PC로 받을 수 있습니다. **운영 데이터는 GitHub에 없습니다.** 현재 기본 위치는 `F:\ChatGPT\DYKIM-PORTAL\data\portal.sqlite`입니다. 이 SQLite 파일에 사용자·설치·자료·자산·고객·업무일지·첨부파일이 함께 저장됩니다. `data/`, `backups/`, `.env`는 Git에서 제외됩니다.

이전은 **옛 PC에서 입력 중지 → 최종 백업 → 새 PC에 복원 → 검증 → 새 PC 사용 시작** 순서입니다. 두 PC를 동시에 사용하면 각자의 데이터가 따로 바뀌며 자동으로 합쳐지지 않습니다. 서버가 켜진 상태의 `portal.sqlite`만 복사하지 말고, 아래의 SQLite 온라인 백업 명령을 사용하세요.

| 준비물 | 확인할 내용 |
|---|---|
| 옛 PC | 포털 폴더에 접근할 수 있고 `npm.cmd run backup`이 실행됨 |
| 새 PC | Windows, Git, Node.js **24.13 이상 24.x** 설치, 인터넷 접속 |
| 이동 수단 | 충분한 용량의 암호화 USB 또는 접근을 제한한 안전한 파일 전송 수단 |
| 로그인 정보 | 기존 포털 관리자 계정의 로그인 정보. DB 복원 시 새 관리자 설정 코드는 필요 없음 |

별도로 SQLite나 Docker를 설치할 필요는 없습니다. Windows 계정 이름이나 포털 설치 경로가 달라도 이전할 수 있습니다. 새 PC의 포털 폴더와 `data/`는 로컬 디스크에 두세요. 새 PC에도 포트 3000을 사용할 수 있어야 합니다. 파일당 최대 500MB 첨부를 사용한다면 데이터베이스·최종 백업·임시 업로드를 담을 공간을 넉넉히 준비하세요. `data/upload-tmp/`의 임시 파일은 이전 대상이 아니며, 완료된 첨부는 SQLite 백업에 포함됩니다.

## 1. 옛 PC에서 입력을 멈추고 최종 백업

모든 사용자의 입력을 끝내고, 옛 PC에서 포털을 더 이상 사용하지 않는다고 정한 뒤 진행합니다. **같은 Windows 사용자 계정**의 PowerShell에서 다음을 실행하세요.

```powershell
Set-Location 'F:\ChatGPT\DYKIM-PORTAL'
Get-ScheduledTask -TaskName 'DYKIM Personal Portal' | Select-Object TaskName,State
Disable-ScheduledTask -TaskName 'DYKIM Personal Portal'
Stop-ScheduledTask -TaskName 'DYKIM Personal Portal'
Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
```

마지막 명령에 포트 3000을 듣는 프로세스가 표시되면 백업 전에 그 프로세스의 소유자와 명령줄을 확인하세요. 이 포털 프로세스가 남아 있다면 [장애 대응 문서의 포트 점검 절차](OPERATIONS.md#b-포트-3000이-이미-사용-중)를 따릅니다. 다른 프로그램은 임의로 종료하지 마세요. 예약 작업을 사용 안 함으로 설정했으므로 옛 PC에 다시 로그인해도 포털이 자동 시작되지 않습니다.

포털 폴더에서 백업을 만들고 **가장 최근 파일의 크기와 시각**을 확인합니다.

```powershell
npm.cmd run backup
$backup = Get-ChildItem -Path '.\backups' -Filter 'portal-*.sqlite' |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $backup -or $backup.Length -le 0) { throw '백업 파일이 없거나 비어 있습니다.' }
$backup | Select-Object FullName,Length,LastWriteTime
```

`npm.cmd run backup`이 실패하거나 새 백업 파일이 만들어지지 않았다면 여기서 멈추고 `data/server.log`, `.env`의 `DATA_DIR`, 디스크 여유 공간을 확인하세요. 오래된 백업을 최종 백업인 것처럼 사용하지 마세요. 가능하면 백업 파일을 별도 보관본으로 한 번 더 복사하고, 새 PC 검증이 끝날 때까지 옛 PC의 `data/`와 `backups/`를 보존합니다.

## 2. 백업 파일을 새 PC로 옮기기

확인한 `backups/portal-날짜.sqlite` **한 파일**을 안전한 이동 수단으로 새 PC에 복사합니다. `.env`를 사용 중이었다면 그 파일도 함께 옮기되, 새 PC에서 설정을 검토해야 합니다. 과거 백업까지 유지하려면 `backups/`를 추가로 옮길 수 있습니다. 실행 로그 `data/server.log`와 `node_modules/`는 이전에 필요하지 않습니다.

백업에는 모든 첨부파일과 사용자 비밀번호 해시 등 민감한 정보가 들어 있습니다. 공개 GitHub 저장소, 일반 채팅, 이메일 첨부에 올리지 마세요.

## 3. 새 PC에 프로그램과 데이터를 설치

새 PC의 PowerShell에서 실행합니다. 아래 예시는 현재 Windows 사용자의 홈 폴더에 포털을 설치합니다. Git과 Node.js가 인식되지 않으면 먼저 설치하고 PowerShell을 새로 여세요.

```powershell
git --version
node --version
$portalPath = Join-Path $env:USERPROFILE 'DYKIM-PORTAL'
git clone https://github.com/dykim-tech/portal.git $portalPath
Set-Location $portalPath
npm.cmd ci
New-Item -ItemType Directory -Path '.\data' -Force | Out-Null
if (Test-Path -LiteralPath '.\data\portal.sqlite') {
  throw '새 PC에 이미 포털 데이터가 있습니다. 덮어쓰기 전에 별도 보관하고 이전 계획을 확인하세요.'
}
```

이동한 최종 백업의 **실제 경로**를 아래 `E:\PortalTransfer\portal-날짜.sqlite` 대신 넣어 복사합니다. 포털을 한 번이라도 실행해 새 DB가 만들어졌다면 기존 DB를 덮어쓰지 말고 먼저 원인을 확인하세요.

```powershell
Copy-Item -LiteralPath 'E:\PortalTransfer\portal-날짜.sqlite' -Destination '.\data\portal.sqlite'
```

`.env`를 옮겼다면 프로젝트 루트에 놓고 열어 확인합니다. 특히 `DATA_DIR`가 옛 PC의 `F:` 경로를 가리키면 새 경로인 `./data`로 바꿉니다. `APP_ORIGIN`은 기본 로컬 접속의 경우 `http://localhost:3000`, `HOST=127.0.0.1`, `PORT=3000`, `COOKIE_SECURE=false`, `TRUST_PROXY=false`가 맞는지 확인하세요. 옛 PC에 별도 `.env`가 없었고 로컬 기본값으로 사용했다면 새 PC에서도 없어도 됩니다. 모바일·외부 접속 설정은 현재 계획 단계이므로, 나중에 사용할 때 새 PC 주소에 맞춰 별도로 설정해야 합니다.

복원한 파일의 무결성을 확인합니다. 출력이 `ok`가 아니면 서버를 시작하지 말고 백업 파일을 다시 확인하세요.

```powershell
node -e "const {DatabaseSync}=require('node:sqlite'); const d=new DatabaseSync('data/portal.sqlite',{readOnly:true}); const r=d.prepare('PRAGMA integrity_check').get(); console.log(r.integrity_check); d.close(); if(r.integrity_check!=='ok')process.exit(1)"
```

마지막으로 새 PC에서 자동 시작 작업을 등록하고 즉시 시작합니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File '.\scripts\windows-install.ps1'
Invoke-RestMethod 'http://127.0.0.1:3000/api/health'
```

성공하면 `Portal is running in the background at http://localhost:3000`과 health 응답의 `ok: true`가 보입니다. 설치 작업은 **현재 Windows 사용자**의 로그인 시 자동 실행되므로 그 사용자가 로그인해야 합니다. 설치 스크립트가 포트 충돌을 보고하면 [포트 점검 절차](OPERATIONS.md#b-포트-3000이-이미-사용-중)로 점유 프로세스를 먼저 식별하세요.

## 4. 새 PC에서 사용 시작 전 확인

1. 새 PC 브라우저에서 [http://localhost:3000](http://localhost:3000)에 접속하여 **기존 관리자 계정**으로 로그인합니다. 새 관리자 만들기 화면이 나오면 입력하지 말고 `data/portal.sqlite`와 `.env`의 `DATA_DIR`부터 확인합니다.
2. 설치·자료·자산·고객·업무일지의 건수를 옛 PC의 최종 백업 시점과 비교합니다. 첨부파일 하나를 열거나 내려받고, 리포트 CSV도 시험합니다.
3. PowerShell을 닫아도 계속 접속되는지 확인하고, 가능하면 새 PC에서 Windows 로그아웃·재로그인 후 자동 시작도 확인합니다.
4. 사용자가 둘 이상이면 새 PC의 로컬 주소 `localhost`는 **그 PC에서만** 접속한다는 점을 알리고, 다른 기기 접속 방식은 별도로 준비합니다. 현재 구성에 모바일 외부 접속은 자동으로 따라오지 않습니다.
5. 확인이 끝나면 새 PC에서 새 백업을 만들고 외부 보관 위치를 정합니다. 옛 PC의 예약 작업은 계속 사용 안 함 상태로 두고, 옛 데이터는 보존 기간을 정해 보관합니다.

## 실패했을 때와 되돌리기

- **새 PC에서 포털이 시작되지 않음:** `Get-Content '.\data\server.log' -Tail 50`, `Get-ScheduledTaskInfo -TaskName 'DYKIM Personal Portal'`, Node 버전, 포트 3000 사용 여부를 확인합니다. [기동 및 장애 대응 절차](OPERATIONS.md)를 참고하세요.
- **자료가 비어 보이거나 초기 설정 화면이 나옴:** 새 자료를 입력하지 말고 예약 작업을 중지합니다. `data/portal.sqlite`가 복원한 파일인지, `.env`의 `DATA_DIR`가 다른 위치를 가리키지 않는지 확인합니다.
- **새 PC에 쓰기 전이라면:** 옛 PC에서 `Enable-ScheduledTask -TaskName 'DYKIM Personal Portal'` 후 `Start-ScheduledTask -TaskName 'DYKIM Personal Portal'`로 기존 운영을 재개할 수 있습니다.
- **새 PC에 이미 새 입력이 생겼다면:** 단순히 옛 PC를 다시 켜면 두 DB의 내용이 달라집니다. 입력을 멈추고 어느 PC의 자료를 기준으로 삼을지 정한 뒤, 그 PC의 새 백업으로 한쪽을 복원해야 합니다. 자동 병합 기능은 없습니다.
- **옛 PC가 고장 나 백업을 새로 만들 수 없다면:** 별도로 보관한 가장 최근 백업으로 복원하며, 그 백업 이후 입력은 복구되지 않을 수 있습니다. 백업이 없고 옛 디스크의 `portal.sqlite`만 남았다면 WAL/SHM 파일 상태를 함께 확인해야 하므로 임의로 새 DB를 만들거나 파일을 섞지 말고 원본 디스크를 보존하세요.

코드 업데이트와 일상 장애 대응은 [운영 절차 문서](OPERATIONS.md)를 참조하세요.
