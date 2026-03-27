---
name: smart-router-runtime-validation
description: Smart-router 실런타임 검증과 UI 표시 확인용 skill. Use when AI needs to validate route behavior in the real OpenClaw runtime, check global npm install behavior, inspect footer model alias rendering, restart the gateway, or verify logs after a smart-router change.
---

# Smart Router Runtime Validation

이 skill 은 코드만 보는 정적 검토가 아니라, 실제 실행 중인 OpenClaw 환경에서 smart-router 동작을 검증할 때 사용한다.

## 이 skill 이 필요한 작업

- 채팅창에서 `local`, `nano`, `mini`, `full` 표시가 기대와 다를 때
- OpenClaw source repo 와 실제 실행 runtime 이 다를 수 있을 때
- 게이트웨이 재시작 후 실호출 route 와 UI metadata 를 함께 봐야 할 때
- 플러그인 메타는 바뀌었는데 UI 반영이 안 되는 이유를 추적할 때

## 핵심 운영 사실

- `/Volumes/ExtData/OpenClaw` 는 참고용 source repo 일 수 있다.
- 실제 실행 OpenClaw 는 글로벌 npm 설치본일 수 있으므로, 먼저 활성 binary 와 버전을 확인한다.
- 현재 검증된 설치본 계열에서는 채팅 footer model 표시에 assistant `message.model` 이 사용될 수 있다.
- 따라서 `smartRouterRoute` 메타만 붙여서는 UI가 바뀌지 않을 수 있다.

## 권장 확인 순서

1. 현재 어떤 OpenClaw binary 가 실행되는지 확인한다.
2. 필요하면 게이트웨이를 재시작한다.
3. smart-router 로그와 JSONL 실행 로그를 함께 본다.
4. UI footer 또는 응답 메타에서 tier alias 가 어떤 필드로 노출되는지 확인한다.

## 실무 체크포인트

- route alias 표시는 `local`, `nano`, `mini`, `full` 중 하나로 일관되어야 한다.
- 실제 provider model ID 가 사라지면 안 된다. UI alias 와 별도로 구조화 메타에 남겨 두는 쪽을 우선 검토한다.
- source repo 에만 수정하고 설치 runtime 에 반영되지 않는 상태를 혼동하지 않는다.

## 유용한 검증 예시

```bash
which openclaw
openclaw --version
tail -f /tmp/openclaw-gateway.log | grep smart-router
```

JSONL 확인 위치:

```text
~/.openclaw/logs/smart-router-YYYY-MM-DD.jsonl
```

## 답변에 남길 내용

- 실제 실행 runtime 위치와 버전
- UI 가 읽는 메타 필드가 무엇인지
- 로그에서 확인한 실제 route 와 응답 tier
- source repo 참고 변경과 runtime 반영 변경을 어떻게 구분했는지