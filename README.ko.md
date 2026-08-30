[简体中文](README.zh-CN.md) | [English](README.md) | [日本語](README.ja.md) | **한국어** | [繁體中文](README.zh-TW.md)

# VectorMind MCP

VectorMind는 AI 코딩 어시스턴트를 위한 로컬 프로젝트 메모리 MCP입니다. 요구사항, 결정, 변경 이유, 프로젝트 규칙과 파일 상태를 프로젝트 디렉터리에 저장하여 장기 개발에서 발생하는 컨텍스트 손실, 프로젝트 간 혼선, 오래된 로직으로의 회귀를 줄입니다.

현재 버전: `1.1.6`

## 핵심 기능

- **프로젝트 컨텍스트 복원**: 현재 목표와 관련된 프로젝트 요약, 요구사항, 결정, 규칙과 메모리를 검색합니다.
- **요구사항 명확성 안내**: MCP server instructions를 통해 완전한 승인이 있을 때만 AI가 작업하고, 승인이 부족하면 사용자에게 먼저 질문하도록 안내합니다.
- **변경 범위 제한**: 편집 전에 요구사항 항목, 계획된 파일, 대형 파일 관리 규칙을 확인합니다.
- **변경 의도 기록**: 변경 파일, 구현 이유, 검증 결과와 남은 문제를 해당 요구사항에 연결합니다.
- **요구사항 수명주기 관리**: 순차 작업, 명시적 병렬 작업, 완료 작업 재개와 검증 결과 업데이트를 지원합니다.
- **권위 있는 결정 갱신**: 새 결정이 이전 요구사항이나 메모리를 supersede하여 후속 세션이 오래된 규칙을 따르지 않게 합니다.
- **여러 프로젝트 격리**: 메모리, pending buffer, 인덱스와 데이터베이스를 `project_root`별로 격리합니다.
- **프로젝트 파일 안전 읽기**: canonical realpath 검증으로 심볼릭 링크나 junction을 이용한 프로젝트 경계 이탈을 거부합니다.
- **신뢰할 수 없는 콘텐츠와 작업 검사**: 파일, 메모리, `grep`, 심볼 조회 결과에 `security_scan`을 포함합니다. 신뢰도가 높은 민감 데이터 유출만 구체적인 작업 사전 검사에서 차단하며, 일반 문서, 기사, 테스트 샘플과 명시적인 일반 업로드는 advisory로 유지됩니다.
- **안전한 SSH 배포 준비**: `prepare_secure_ssh`는 호스트 내부에서 서버 설정을 읽고 대상 메타데이터와 SSH 설정 경로만 반환하며 비밀번호나 개인 키를 노출하지 않습니다. 기존 호스트 SSH 키를 우선 사용하고, 없으면 임시 Ed25519 키를 생성하여 비밀번호 인증을 비활성화하고 공개 키를 먼저 설치하도록 요구합니다.
- **장기 세션 체크포인트 저장**: 제한되고 버전이 지정된 checkpoint를 만들고 컨텍스트를 읽기 전용으로 복원하거나 비교합니다.
- **메모리 품질 진단**: 충돌, 중복, 과도한 checkpoint, 오래된 인덱스와 고립된 메모리를 검사합니다.
- **컨텍스트 크기 제어**: 기본적으로 간결한 도구 집합과 출력을 사용하고 큰 결과에서도 핵심 ID와 완료 상태를 유지합니다.

전체 내용은 [기능 매트릭스(중국어 간체)](docs/capability-matrix.md)를 참조하십시오.

## 빠른 설치

프로젝트 URL을 AI 코딩 어시스턴트에 보내 설치와 설정을 자동으로 완료하게 하는 방식을 권장합니다.

```text
VectorMind MCP를 설치하고 설정해 주세요:
https://github.com/yuanfeng-net/VectorMind

현재 사용 중인 AI 코딩 클라이언트를 자동으로 식별하고 설치, MCP 설정, 사용 가능 여부 검증까지 완료해 주세요.
필수 권한이 없는 경우가 아니라면 수동 명령 실행을 요구하지 마세요.
```

대부분 GitHub URL과 “설치해 줘”라는 요청만으로 충분합니다. AI가 현재 클라이언트를 식별하고 MCP 설정을 갱신한 뒤 사용 가능 여부를 검증합니다.

## 수동 설치 및 설정(선택 사항)

Node.js `20.19.0` 이상이 필요합니다.

MCP 직접 실행:

```bash
npx -y @coreyuan/vector-mind
```

또는 전역 설치:

```bash
npm install -g @coreyuan/vector-mind
```

전역 설치 후 다음 세 명령을 사용할 수 있습니다.

```text
vector-mind        # MCP stdio 서버
vector-mind-admin  # 프로덕션 관리 패널
rtk                # RTK 호환 진입점
```

### Codex 수동 설정

`~/.codex/config.toml`에 추가합니다.

```toml
[mcp_servers.vector-mind]
type = "stdio"
command = "npx"
args = ["-y", "@coreyuan/vector-mind"]
```

설정 후 Codex를 다시 시작하고 새 작업에서 사용하십시오.

### Claude Desktop 수동 설정

```json
{
  "mcpServers": {
    "vector-mind": {
      "command": "npx",
      "args": ["-y", "@coreyuan/vector-mind"]
    }
  }
}
```

## 관리 패널

MCP 설치와 설정이 끝나면 관리 패널이 `vector-mind` MCP 프로세스와 함께 백그라운드에서 자동 시작됩니다. 별도 서비스를 실행할 필요가 없습니다.

```text
http://127.0.0.1:16860
```

문제 해결을 위해 수동으로 시작할 수도 있습니다.

```bash
vector-mind-admin
```

기본 주소는 [http://127.0.0.1:16860](http://127.0.0.1:16860)입니다. 기본적으로 루프백 주소만 수신하고 루프백 요청에 현재 페이지 세션을 생성하므로 토큰을 직접 입력할 필요가 없습니다.

페이지를 열거나 새로 고칠 때 Codex 데스크톱의 `$CODEX_HOME/.codex-global-state.json`에서 로컬 프로젝트 목록을 읽기 전용으로 동기화하고 Codex 순서대로 표시합니다. 존재하지 않는 디렉터리는 건너뛰며, 수동으로 추가했거나 디렉터리 검색으로 찾은 프로젝트는 Codex 동기화가 삭제하지 않습니다.

소스에서 실행:

```bash
npm ci
npm run build
npm run admin:start
```

개발 모드는 Vite 미들웨어와 HMR을 사용합니다.

```bash
npm run admin:dev
```

사용 가능한 환경 변수:

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `VECTORMIND_ADMIN_HOST` | `127.0.0.1` | 관리 서비스 수신 주소 |
| `VECTORMIND_ADMIN_PORT` | `16860` | 관리 서비스 포트 |
| `VECTORMIND_ADMIN_TOKEN` | 없음 | 루프백 이외 주소에서 수신할 때 필수 |
| `VECTORMIND_ADMIN_AUTO_START` | `true` | `false`, `0`, `no`, `off`, `disabled`로 설정하면 MCP 연동 자동 시작을 비활성화 |

루프백 이외 주소에서 수신할 때 서비스는 시작 단계에서 `VECTORMIND_ADMIN_TOKEN`을 요구합니다. 토큰은 `/api/config`에서 반환되지 않으며 브라우저 입력값은 현재 탭의 `sessionStorage`에만 저장됩니다. 보호된 API는 토큰과 동일 출처 `Origin`을 모두 검증하며, `Origin`이 없어도 토큰 검증을 우회할 수 없습니다.

전체 설명은 [관리 패널 문서(중국어 간체)](admin-panel/README.md)를 참조하십시오.

## 사용 방법

VectorMind 도구 명령을 기억하거나 직접 입력할 필요가 없습니다. 평소처럼 자연어로 목표, 제약 조건과 기대 결과를 설명하면 AI 클라이언트가 필요할 때 관련 컨텍스트를 복원하고 변경 범위를 검사하며 변경 이유를 기록합니다.

한 세션에서 관련 없는 여러 작업을 동시에 처리해야 한다면 병렬로 유지할 작업과 각 프로젝트 및 목표를 AI에 명시하십시오. 내부 요구사항 ID와 도구 호출은 클라이언트가 관리합니다.

VectorMind의 품질 신호는 컨텍스트 증거일 뿐 모델이나 사용자를 대신해 결정하지 않습니다.

### 보안 검사 범위와 오버헤드

보안 검사는 프롬프트 인젝션, 자격 증명 접근, 호스트 탐색과 로컬 민감 데이터 유출을 식별합니다. 다른 MCP 도구를 장악하거나 AI의 추론, 설계, 구현 방향을 결정하지 않습니다.

- 파일, 메모리, `grep`, 시맨틱 검색과 심볼 조회가 반환하는 검사는 `advisory_only`, `coverage`, `complete`로 표시된 advisory 신호입니다.
- `preflight_operation_scope`가 신뢰도 높은 민감 자격 증명 유출을 탐지한 구체적 작업에만 blocker를 반환합니다. MCP로 기록한 decision, requirement, note, convention에는 호스트가 인증한 사용자 출처가 없으므로 warning만 만들 수 있으며 현재 사용자 요청을 덮거나 `safe_to_proceed`를 false로 만들 수 없습니다. 일반 읽기, 조회, 코드 생성과 다른 MCP 기능은 영향을 받지 않습니다.
- 배포 설명, 파일 목록, `--exclude`, 원격 대상 경로와 `ssh/scp -i` identity file은 업로드 콘텐츠로 취급하지 않습니다. 로컬 `.env`가 배포 원본이면 기본 차단합니다. 신뢰 대상은 호스트 시작 변수 `VECTORMIND_DEPLOYMENT_HOST`에 등록된 정규화 IPv4/IPv6 리터럴 또는 `prepare_secure_ssh`가 생성, 등록, 해시 검증한 `-F` 설정으로 제한합니다. 저장소의 `server.txt`만으로는 신뢰를 만들 수 없고 잘못된 환경값은 fail closed됩니다. `.env` 또는 추적 가능한 복사, 이름 변경, 인코딩, 아카이브 파생물이 해당 IP로 신뢰된 시스템 OpenSSH/SSH-style rsync를 통해서만 전송될 때만 예외가 적용됩니다. 링크 파생물, SSH 개인 키, 클라우드 자격 증명, `server.txt`, 호스트 환경 변수에는 예외가 없습니다.
- 등록된 `-F` 설정이 없는 민감 SSH 업로드에서만 `ssh -G`를 실행합니다. 실제 원격 사용자, 포트와 안전한 `-o`를 포함하여 검증하고 최종 `hostname`이 대상 IP인지, 공개 키 인증과 `BatchMode`, 호스트 키 검증을 사용하는지 확인합니다. 비밀번호, keyboard-interactive, 제어 소켓 재사용, Agent/stdio/포트 전달, 점프 프록시, `ProxyCommand`, `LocalCommand`, `KnownHostsCommand`, 빈 known-host 파일은 금지합니다. 일반 build/test/git와 등록된 설정을 사용하는 배포에서는 실행하지 않습니다.
- 현재 작업이 변경하지 않은 실행 검색 환경의 표준 명령 이름과 `/usr/bin`, `/bin`, Windows System32 OpenSSH의 명시적 경로를 허용합니다. 단순 명령 이름을 파일 해시 검증으로 주장하지 않습니다. `./scp`, `/tmp/ssh`, 위장 스크립트, 사용자 지정 SSH/SCP/SFTP 또는 제어 소켓, 전달 옵션, 위험한 `-o`, 사용자 지정 rsync transport는 예외를 받지 않습니다. 표준 `rsync -e ssh`, `/usr/bin/ssh`, 안전한 `RSYNC_RSH=ssh`는 호환됩니다.
- 데이터 흐름은 명령 순서대로 변수 기반 copy/move, 심볼릭/하드 링크, base64, tar/zip/7z, `dd`, 민감 환경 변수 기록, 스크립트/PowerShell 파일 기록과 리디렉션으로 전파됩니다. `curl`, `wget`, PowerShell HTTP, SSH 계열, SFTP inline `put`, `nc`, `openssl s_client`, 파이프와 stdin 업로드 sink를 인식합니다. 출력을 알 수 없는 민감 처리는 후속 업로드를 보수적으로 오염시킵니다. 덮어쓰기, 같은 경로 재패키징, 알 수 없는 스크립트 수정, hash redirect는 신뢰 상태를 무효화합니다. 링크 파생물은 추적하더라도 TOCTOU 방지를 위해 예외를 받지 않습니다. 같은 계획의 독립 자격 증명 읽기나 신뢰되지 않은 유출은 전체 예외를 취소합니다. PATH/동적 로더, alias/function, 변수 SSH 옵션, 간접 shell/PowerShell/cmd 실행 또는 SSH 설정을 수정하는 명령 치환도 예외를 취소하며 읽기 전용 SSH 설정과 백업은 영향을 받지 않습니다.
- `prepare_secure_ssh` 설정과 자동 생성 키는 기본 24시간 후 만료되며 `VECTORMIND_PREPARED_SSH_TTL_SECONDS`로 조정할 수 있습니다. 용량 제거와 프로세스 종료 시 MCP 생성 임시 디렉터리를 정리하고 재사용한 사용자 개인 키는 삭제하지 않습니다. 설정 경로는 realpath containment를 사용합니다. 호스트 절대 경로는 반환할 수 있지만 개인 키 내용은 모델에 반환하지 않습니다.
- `preflight_operation_scope`는 추가 키나 서명 token 없이 `safe_to_proceed`와 blocker를 직접 반환합니다. MCP는 Codex나 다른 클라이언트의 터미널 권한을 제어하지 않으며 실제 OS 명령 권한은 호스트가 담당합니다.
- 모델에 보이는 매개변수에는 보안 blocker 승인 우회가 없습니다. 표준 MCP 인자는 현재 사용자 출처를 증명할 수 없으므로 모델 가시 token이나 “사용자가 확인했다”는 텍스트를 신뢰 승인으로 받지 않습니다.
- 검사는 제한된 로컬 CPU, 파일 읽기와 소량의 출력 token만 사용하며 AI 추론 라운드를 늘리지 않습니다. finding이 없으면 compact 출력은 보안 세부 정보를 펼치지 않으며 전체 필드는 `format=json`으로 볼 수 있습니다.

전체 기능과 경계는 [기능 매트릭스(중국어 간체)](docs/capability-matrix.md)를 참조하십시오.

## 요구사항 명확성 소프트 가이드

VectorMind는 MCP 핸드셰이크에서 AI에 요구사항 명확성 규칙을 제공합니다. 현재 메시지가 작업을 명시적으로 요청하거나 정확히 하나의 미완료 사용자 요청을 가리키고, 선택된 요청이 결과, 대상, 범위와 행동을 정의할 때만 AI가 작업해야 합니다. 완료된 요청은 새 작업을 승인하지 않습니다. 완전한 승인이 없으면 도구를 호출하거나 행동하기 전에 사용자에게 질문합니다.

이 기능은 advisory guidance입니다. VectorMind는 현재 메시지와 사용자 요청에 적용할 판단 경계를 제공할 뿐 모델 추론이나 호스트 런타임을 제어하지 않습니다. 요구사항이 명확하면 AI는 합리적인 기본값으로 계속 진행할 수 있습니다.

## 대형 파일 규칙

구현 파일이 대형 임계값에 도달하면 새 책임을 추가하기 전에 기계적인 모듈 분리를 요구합니다.

- 실제 모듈 이름과 명확한 디렉터리 구조를 사용합니다.
- 외부 동작을 유지하고 분리 후 모듈 경계를 검증합니다.
- `*.generated.*`, `.parts`, `*.rs.parts`, `part1/part2`, `1_xxx/2_xxx` 같은 가짜 분할이나 순번 이름을 금지합니다.
- 분할 계획과 실제 결과를 저장하여 후속 세션에서 같은 계획을 계속할 수 있습니다.

## 하지 않는 일

VectorMind는 로컬 프로젝트 메모리, 개발 규칙과 품질 증거만 제공하며 다음을 수행하지 않습니다.

- Codex, Claude 또는 다른 클라이언트의 실행 제어.
- 모델을 대신한 추론, 설계 또는 구현 결정.
- 클라이언트 권한, 확인 창 또는 실행 정책 변경.
- 모호한 요구사항이나 클라이언트 도구에 대한 런타임 강제 차단. 요구사항 명확성은 소프트 가이드입니다.
- checkpoint를 파일, 데이터베이스 또는 모델 상태 롤백으로 취급.

현재 사용자 지시와 직접 관찰한 저장소 사실은 항상 과거 메모리보다 우선합니다.

## 개발 및 릴리스

```bash
npm ci
npm run build
npm run smoke
npm run verify
```

- `npm run smoke`는 코어 산출물을 다시 빌드하고 security, checkpoint, operation 및 전체 MCP smoke를 실행합니다.
- `npm run verify`는 코어 빌드, 관리 패널 테스트와 프로덕션 빌드, 모든 smoke를 실행합니다.
- `security-regression-cases.mjs`는 프롬프트 인젝션, 자격 증명 경로, 일반 업로드, 민감 유출, DNS/SSH/SCP/SFTP, PowerShell, Node/Python, base64, tar/zip/7z, `dd`, 파생 파일 stdin과 환경 변수 채널을 다룹니다.
- 보안 회귀는 호스트 승인 token, 잘못된 token 우회, 대상 호스트 allowlist, 파일 advisory 의미, 여러 파일 grep 범위와 심볼릭 링크 경계도 검증합니다.
- `npm run verify`에는 위의 보안 회귀, checkpoint/operation 회귀, 관리 패널 테스트와 프로덕션 빌드가 모두 포함됩니다.
- `prepublishOnly`는 전체 `verify`를 강제합니다.
- 릴리스 전에 `npm pack --dry-run --ignore-scripts --json`으로 코어 산출물, 관리 서비스와 사전 빌드 클라이언트 포함 여부를 확인할 수 있습니다.

릴리스:

```bash
npm publish --access public
```

## 라이선스 및 소유권

Copyright (c) 2025-2026 the VectorMind Licensor, publishing as yuanfeng-net. All rights reserved.

VectorMind는 [VectorMind Source-Available License 1.0](LICENSE)을 사용하는 source-available 소프트웨어이며 OSI 정의의 오픈 소스가 아닙니다.

- 개인과 조직은 설치, 실행, 내부 사용, 비공개 수정과 필요한 백업을 할 수 있습니다. 직원, 계열사, 계약상 제한된 계약자, 사용자를 대신해 운영되는 클라우드 CI/CD와 인프라도 사용할 수 있습니다.
- VectorMind로 생성하거나 처리한 코드, 문서, 메모리, 보고서 등 독립 산출물은 사용자에게 귀속되며 VectorMind를 사용했다는 이유만으로 본 라이선스의 제한을 받지 않습니다.
- 공개 미러, 복사, 재패키징, 이름을 바꾼 게시, 수정 버전 배포에는 Licensor의 사전 서면 허가가 필요합니다.
- 저작권, 라이선스, 저자 표시, 공식 프로젝트 링크와 npm 출처를 제거할 수 없습니다.
- VectorMind 또는 주요 기능을 제3자 제품이나 서비스로 제공하거나 복사본을 독자적 또는 공식 버전으로 허위 표시할 수 없습니다.

유일한 공식 저장소는 <https://github.com/yuanfeng-net/VectorMind>이며 공식 npm 패키지는 [`@coreyuan/vector-mind`](https://www.npmjs.com/package/@coreyuan/vector-mind)입니다. [LICENSE](LICENSE)의 영문 원문이 우선합니다. 재배포, OEM, 호스팅 서비스나 기타 상업 권한은 [LICENSING.md](LICENSING.md)에 따라 신청하십시오. 외부 코드 기여는 명확한 권리 관계를 유지하기 위해 [CONTRIBUTING.md](CONTRIBUTING.md)를 따릅니다.

## 한 문장으로

VectorMind는 AI가 요구사항, 결정, 변경 이유와 프로젝트 경계를 기억하게 하여 장기 개발에서 컨텍스트 손실, 의도하지 않은 수정과 오래된 로직으로의 회귀를 줄입니다.

집중 컨텍스트 복원은 관련성에 따라 명시적으로 필터링되고 전체 복원도 출력 한도가 있습니다. 어느 모드도 저장소 전체나 실시간 런타임을 포괄한다고 주장하지 않습니다. 일치 항목이 없다는 것이 어떤 사실도 존재하지 않았음을 증명하지는 않습니다. 도메인, 출발 호스트, 포트, 배포 디렉터리와 자격 증명 파일 참조 같은 지속적 운영 사실은 복원할 수 있지만 비밀 값은 장기 메모리 저장, 심볼 추출과 문서 인덱싱 전에 재귀적으로 마스킹됩니다. 요구사항 생성은 신뢰도 높은 중복을 보고하거나 거부하여 진행 중인 사건이 새 수명주기로 조용히 분리되지 않게 합니다.
