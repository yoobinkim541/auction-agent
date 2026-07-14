import { describe, it, expect } from 'vitest';
import { classifyEgress, configuredHomeIps } from './egress.ts';

describe('classifyEgress', () => {
  it('등록 집 IP는 org와 무관하게 home', () => {
    expect(classifyEgress({ ip: '1.2.3.4', org: 'Oracle Cloud' }, configuredHomeIps('1.2.3.4'))).toBe('home');
  });

  it('데이터센터 org는 datacenter', () => {
    expect(classifyEgress({ ip: '5.6.7.8', org: 'AS31898 Oracle Cloud Infrastructure' }, configuredHomeIps(undefined))).toBe('datacenter');
  });

  it('주거용 ISP org는 home', () => {
    expect(classifyEgress({ ip: '9.9.9.9', org: 'Korea Telecom' }, configuredHomeIps(undefined))).toBe('home');
  });

  it('확인 불가 org는 unknown으로 fail-closed 대상', () => {
    expect(classifyEgress({ ip: '9.9.9.9', org: 'Example Networks' }, configuredHomeIps(undefined))).toBe('unknown');
  });
});
