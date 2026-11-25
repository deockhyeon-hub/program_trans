# AGENTS.md — 코덱스(Codex) · 다른 AI 에이전트용 안내 (program_trans · Biz 번역)

이 저장소에는 `CLAUDE.md` 가 없다. 일을 시작하기 전에 `README.md`(구조 · 배포 · 사람 말투 규칙 · 번역 품질 점검표)와 `DEVLOG.md` 마지막 5개 항목을 읽고 그대로 따른다. 회사 공통 개발 규칙의 기준 사본은 program_lab 저장소 `CLAUDE.md`(공통 규칙 1 ~ 45)다.

- 대표(김덕현)에게 하는 모든 답은 한국어, 쉬운 말로. 화면 글과 답에 «» · 「」 괄호를 쓰지 않는다.
- 비밀번호 · 토큰 · API 열쇠는 출력하지 않는다. 보내기 · 지우기 · 확정 · 관리 설정은 대표가 그 말을 한 뒤에만.
- 일이 끝나면 `DEVLOG.md` 맨 아래에 `### <번호> · <MM-DD HH:MM> — <제목>` 으로 기록한다.
- 개발 기본값 = 오픈소스 먼저(공통 규칙 44): 짜기 전에 이 저장소 함수 → 언어 · 브라우저 기본 기능 → 이미 깐 패키지 → GitHub 유명 오픈소스(허용 라이선스) 순으로 찾는다.

## Claude · Codex 함께 일하기 — 인계 기록 (공통 규칙 45 · CODEXPAIR_1125)

- 이 저장소 개발은 Claude Code 세션이 총괄하고 Claude 와 Codex 가 같이 구현한다.
- 일을 시작하기 전에 진행 중인 일이 있는지 본다. 인계 기록은 일하는 가지 맨 위 `HANDOFF.md` 에 있다(main 에는 없다):
  `git fetch -q origin; for b in $(git for-each-ref --sort=-committerdate --format='%(refname:short)' refs/remotes/origin | head -20); do git cat-file -e "$b:HANDOFF.md" 2>/dev/null && echo "$b"; done`
  지금 받은 가지에 `HANDOFF.md` 가 있으면 그것이 이어받을 일이다. 남은 것을 위에서부터 한다.
- 이어서 한 뒤에는 `HANDOFF.md` 를 고친다(마지막으로 확인한 커밋 · 한 것 · 남은 것 · 시험 결과 · 이어받은 기록 한 줄 · 시각은 한국 시각) → 같은 가지에 커밋 · push. 커밋 · push 를 못 하면 무엇이 어느 경로에 로컬로만 있는지 답과 `HANDOFF.md` 에 적는다. `지킬 것` 절은 고치지 않는다.
- 맡은 범위 밖 파일은 고치지 않는다. 남의 미커밋 변경은 그대로 둔다. 시험은 직접 돌리고 명령과 결과를 적는다.
- main 에 합치기(GitHub Pages 배포) · 실서버 자료 변경은 대표가 그 말을 한 뒤에만. 강제 push 는 하지 않는다.
- 자세한 규칙과 `HANDOFF.md` 틀: program_lab 저장소 `docs/개발기준/09_Claude_Codex_함께_운영.md`.
