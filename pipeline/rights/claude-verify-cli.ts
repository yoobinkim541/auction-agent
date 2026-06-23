/**
 * Claude 권리분석 2차 검증 — 로컬 `claude` CLI(Claude Code) 경유.
 *
 * 목적: Anthropic 종량제 API 대신 사용자의 **Claude Max 구독**으로 실행하여 추가 과금 0.
 * (claude CLI가 구독 OAuth로 인증돼 있으면 사용량이 구독 한도에서 차감됨)
 *
 * claude-verify.ts(API 버전)와 동일한 입력/출력. run.ts가 키 유무에 따라 선택.
 */
import { spawn } from 'node:child_process';
import type { VerifyArgs, VerifyOutput } from './claude-verify.ts';
import { parseVerifyOutput } from './claude-verify.ts';

export const VERIFY_CLI_MODEL = 'claude-cli(subscription)';

function buildPrompt(args: VerifyArgs): string {
  const legal = (args.legalContext ?? [])
    .map((c, i) => `[${i + 1}] ${c.lawName} ${c.article}\n${c.content}`)
    .join('\n\n');
  return [
    '당신은 대한민국 부동산 경매 권리분석을 검토하는 보조 분석가입니다.',
    '원칙: (1) 인수/소멸·말소기준·대항력 판정은 이미 결정형 엔진이 했고 당신은 검토·설명·위험지적만 한다. ' +
      '(2) 법령/판례 인용은 아래 "참고 법령" 안의 내용만 사용하고 없으면 citations를 빈 배열로 둔다(조문 지어내기 금지). ' +
      '(3) 참고용 정보이며 법률자문이 아니다. 유치권 등 등기부 외 권리는 단정하지 말고 현장/전문가 확인으로 안내한다.',
    '',
    '## 엔진 권리분석 결과(JSON)',
    JSON.stringify(args.engineResult),
    args.sourceText ? `\n## 원문 문서\n${args.sourceText.slice(0, 8000)}` : '',
    `\n## 참고 법령${legal ? '' : ': 없음(citations 빈 배열)'}\n${legal}`,
    '',
    '아래 JSON 객체 **하나만** 출력하라(마크다운/설명 금지):',
    '{"agrees":boolean,"discrepancies":[{"field":string,"engineSays":string,"concern":string}],' +
      '"explanation":string,"riskSummary":string,"citations":[{"law":string,"article":string,"quote":string}],' +
      '"recommendedChecks":[string]}',
  ]
    .filter(Boolean)
    .join('\n');
}

export function extractJson(text: string): VerifyOutput {
  let t = text.trim();
  // 코드펜스 제거
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  // 첫 { ~ 마지막 } 만 취함
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s >= 0 && e > s) t = t.slice(s, e + 1);
  return parseVerifyOutput(JSON.parse(t));
}

export async function verifyRightsCli(args: VerifyArgs, model?: string): Promise<VerifyOutput> {
  const prompt = buildPrompt(args);
  const cliArgs = ['-p', '--output-format', 'json', '--max-turns', '1'];
  if (model) cliArgs.push('--model', model);

  const out = await new Promise<string>((resolve, reject) => {
    const cp = spawn('claude', cliArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      cp.kill('SIGKILL');
      reject(new Error('claude CLI 타임아웃'));
    }, 120_000);
    cp.stdout.on('data', (d) => (stdout += d));
    cp.stderr.on('data', (d) => (stderr += d));
    cp.on('error', reject);
    cp.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude CLI exit ${code}: ${stderr.slice(0, 300)}`));
      resolve(stdout);
    });
    cp.stdin.write(prompt);
    cp.stdin.end();
  });

  // --output-format json 봉투에서 result(모델 최종 텍스트) 추출 후 내부 JSON 파싱
  const envelope = JSON.parse(out) as { result?: string };
  return extractJson(envelope.result ?? out);
}

/** claude CLI 사용 가능 여부 */
export async function claudeCliAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const cp = spawn('claude', ['--version'], { stdio: 'ignore' });
    cp.on('error', () => resolve(false));
    cp.on('close', (code) => resolve(code === 0));
  });
}
