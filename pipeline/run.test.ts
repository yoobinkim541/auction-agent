import { describe, expect, it } from 'vitest';
import { extractTenantsFromNotes } from './run.ts';

describe('extractTenantsFromNotes', () => {
  it('"인수권리" 등 매각효력 이외의 제목에서도 대항력 임차인을 추출한다', () => {
    const notes = [
      '인수권리: 매수인에게 대항할 수 있는 을구 순위 4번 임차권등기(2024.12.12. 등기) 있음' +
        '(임대차보증금 1억5천만 원, 전입일 2022.12.6., 확정일자 2022.8.30.). ' +
        '배당에서 보증금이 전액 변제되지 아니하면 잔액을 매수인이 인수함',
    ];
    const tenants = extractTenantsFromNotes(notes);
    expect(tenants).toHaveLength(1);
    expect(tenants[0]!.deposit).toBe(150_000_000);
    expect(tenants[0]!.moveInDate).toBeDefined();
    expect(tenants[0]!.occupied).toBe(true);
  });

  it('"매각효력" 제목이 붙은 기존 표기도 계속 추출한다(회귀 방지)', () => {
    const notes = ['매각효력: 매수인에게 대항할 수 있는 임차인이 있음(임대차보증금 100,000,000원, 전입일자 2021.01.01)'];
    const tenants = extractTenantsFromNotes(notes);
    expect(tenants).toHaveLength(1);
    expect(tenants[0]!.deposit).toBe(100_000_000);
    expect(tenants[0]!.moveInDate).toBe('2021-01-01');
  });

  it('"전입일자" 대신 "전입일"(자 없음) 표기도 전입일로 인식한다', () => {
    const notes = ['매수인에게 대항할 수 있는 임차인이 있음(임대차보증금 195,000,000원, 전입일 2020.8.3, 확정일자 2020.8.3)'];
    const tenants = extractTenantsFromNotes(notes);
    expect(tenants).toHaveLength(1);
    expect(tenants[0]!.deposit).toBe(195_000_000);
    expect(tenants[0]!.moveInDate).toBe('2020-08-03');
  });

  it('"대항할 수 있는"이 있어도 보증금·전입일이 전혀 없으면 추출하지 않는다(오탐 방지)', () => {
    const notes = ['일반적으로 매수인에게 대항할 수 있는 권리가 존재할 수 있음(해당사항 없음)'];
    expect(extractTenantsFromNotes(notes)).toHaveLength(0);
  });

  it('대항력 언급이 없는 노트는 무시한다', () => {
    const notes = ['최선순위설정: 2023.7.6. 근저당권'];
    expect(extractTenantsFromNotes(notes)).toHaveLength(0);
  });

  it('한 노트에 여러 임차인 블록이 있으면 모두 추출한다', () => {
    const notes = [
      '매수인에게 대항할 수 있는 을구 순위 2번 주택임차권 등기(임대차보증금 50,000,000원, 전입일자 2019.03.05)' +
        '매수인에게 대항할 수 있는 을구 순위 3번 주택임차권 등기(임대차보증금 70,000,000원, 전입일자 2020.05.10)',
    ];
    const tenants = extractTenantsFromNotes(notes);
    expect(tenants).toHaveLength(2);
  });
});
