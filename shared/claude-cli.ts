/**
 * `claude -p` 한 번 호출에 쓰는 공통 인자.
 * 기본값으로 부르면 Claude Code 의 시스템 프롬프트·도구 정의·설정 파일이 매 호출에 실려 입력이 약 4.6만 토큰이 된다
 * (2026-11 실측, 한 단어 답에도 동일). 시스템 프롬프트를 바꾸고 도구·설정·MCP 를 끄면 약 600 토큰이다.
 * `--tools ""` 만 끄고 설정을 남기면 오히려 늘어난다(37만 토큰 실측) — 넷을 함께 쓴다.
 */
export const CLAUDE_PRINT_ARGS: readonly string[] = [
  '-p', '--output-format', 'json', '--max-turns', '1',
  '--system-prompt', '요청한 형식으로만 답한다.',
  '--tools', '',
  '--setting-sources', '',
  '--strict-mcp-config',
];
