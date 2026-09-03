import { describe, it, expect } from 'vitest';
import { classifyEgress, configuredHomeIps } from './egress.ts';

describe('classifyEgress', () => {
  it('등록 IP여도 데이터센터 조직이면 datacenter로 차단', () => {
    expect(classifyEgress({ ip: '1.2.3.4', org: 'Oracle Cloud' }, configuredHomeIps('1.2.3.4'))).toBe('datacenter');
  });

  it('등록 IP와 주거용 ISP 증거가 모두 있을 때만 home', () => {
    expect(classifyEgress({ ip: '1.2.3.4', org: 'KT Corporation residential broadband' }, configuredHomeIps('1.2.3.4'))).toBe('home');
  });

  it('등록 IP여도 조직이 불명이면 unknown으로 fail closed', () => {
    expect(classifyEgress({ ip: '1.2.3.4', org: 'Example Networks' }, configuredHomeIps('1.2.3.4'))).toBe('unknown');
  });

  it('데이터센터 org는 datacenter', () => {
    expect(classifyEgress({ ip: '5.6.7.8', org: 'AS31898 Oracle Cloud Infrastructure' }, configuredHomeIps(undefined))).toBe('datacenter');
  });

  it('주거용 ISP org만으로는 exact home이 아님', () => {
    expect(classifyEgress({ ip: '9.9.9.9', org: 'Korea Telecom' }, configuredHomeIps(undefined))).toBe('residential_isp');
  });

  it('주거용 ISP라도 등록 집 IP가 아니면 통과시키지 않음', () => {
    expect(classifyEgress({ ip: '9.9.9.9', org: 'Korea Telecom' }, configuredHomeIps('1.2.3.4'))).not.toBe('home');
  });

  it('직접 VM IP와 다르더라도 등록 집 IP가 아니면 home이 아님', () => {
    expect(classifyEgress({ ip: '8.8.8.8', org: 'Google LLC' }, configuredHomeIps('1.2.3.4'))).toBe('datacenter');
  });

  it('확인 불가 org는 unknown으로 fail-closed 대상', () => {
    expect(classifyEgress({ ip: '9.9.9.9', org: 'Example Networks' }, configuredHomeIps(undefined))).toBe('unknown');
  });
});
