# 크롤 프록시 — 집(주거용) IP로 나가기 (SSH SOCKS)

## 왜 필요한가

이 Oracle VM의 **데이터센터 IP**가 양쪽 소스에서 막힌다:

- **법원경매**(courtauction.go.kr): VM IP를 API 레벨에서 차단(`ipcheck:false` / 빈 결과). → 폴백이 "성공"으로 찍혀도 0건.
- **더낙찰옥션**: 개인 구독 계정을 **클라우드 IP로 로그인**하는 것 자체가 계정 플래그 트리거(→ 비정상접속 차단).

해법: 크롤 트래픽을 **집(주거용) 회선**으로 내보낸다. SSH SOCKS 터널을 쓰면 추가 데몬 없이 가능하다.
코드는 이미 프록시를 탄다 — Playwright(더낙찰)는 `CRAWL_PROXY`를, 법원경매 `fetch`는 `crawler/proxy.ts`의
`crawlFetch`를 통해 같은 `CRAWL_PROXY`를 사용한다(socks5/socks4/http 지원).

> ⚠️ 더낙찰은 프록시만으로 안 풀린다 — **계정 플래그**가 먼저 해제돼야 한다(1577-9352 전화). 프록시는
> 계정 복구 후 재발(클라우드 IP 로그인) 방지용. 법원경매는 프록시만으로 바로 효과가 있다.

---

## 1. 터널 띄우기 — 둘 중 하나

집 PC의 OpenSSH가 7.6+ 인지 확인(`ssh -V`). 둘 다 VM에 `127.0.0.1:1080` SOCKS5를 만든다.

### A. 역방향(권장) — 집이 공유기/NAT 뒤일 때
집 PC에서 실행(집→VM 접속이라 집에 공인 SSH가 필요 없음):

```bash
# 집 PC에서
ssh -N -R 1080 ubuntu@<VM_공인_IP>
#   -R 1080  : VM의 127.0.0.1:1080 에 리버스 SOCKS5 (트래픽은 집 회선으로 egress)
#   -N       : 셸 없이 터널만
```

### B. 정방향 — 집에 공인 SSH(포트포워딩)가 있을 때
VM에서 실행(VM→집 접속):

```bash
# VM에서
ssh -N -D 1080 <집계정>@<집_공인_IP>
```

### 끊겨도 살아나게(권장: autossh)
```bash
# 집 PC(역방향 예)
autossh -M 0 -N -R 1080 ubuntu@<VM_공인_IP> \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes
```
상시 운영이면 systemd(리눅스)/launchd(맥) 서비스로 등록.

---

## 2. VM에서 프록시 지정

`.env` 에 추가(크롤러는 `dotenv/config` 로 자동 로드):

```
CRAWL_PROXY=socks5://127.0.0.1:1080
```

여러 회선이면 순차 폴백(차단 시 다음으로):
```
CRAWL_PROXIES=socks5://127.0.0.1:1080,socks5://127.0.0.1:1081
```

---

## 3. 검증 (터널 띄운 상태에서, VM에서)

```bash
# (a) 터널 자체 — 집 IP가 떠야 함(217.142.149.79=VM이면 실패)
curl --socks5-hostname 127.0.0.1:1080 https://api.ipify.org ; echo

# (b) 코드 경로 — crawlFetch egress가 집 IP인지
CRAWL_PROXY=socks5://127.0.0.1:1080 npx tsx -e \
  "import {crawlFetch} from './crawler/proxy.ts'; crawlFetch('https://api.ipify.org').then(r=>r.text()).then(t=>console.log('egress',t))"

# (c) 법원경매만 프록시로 실제 수집(차단 풀렸는지)
CRAWL_PROXY=socks5://127.0.0.1:1080 npm run crawl -- --source=courtauction --max=10
```

(c)에서 `[courtauction] 수집 완료: N건`(N>0)이면 성공. 0건/IP 차단 로그면 터널 egress IP를 (a)로 다시 확인.

---

## 4. 주의

- **집 PC가 켜져 있고 터널이 살아 있어야** cron 크롤이 나간다. 꺼지면 fetch 실패 → (더낙찰은) 쿨다운/폴백.
- 법원경매는 프록시로 바로 효과. 더낙찰은 **계정 해제(전화) 후** 프록시+집 IP로 돌려야 재플래그를 피한다.
- VM `sshd`는 기본값(`AllowTcpForwarding yes`)이면 역방향 SOCKS에 추가 설정 불필요(127.0.0.1 바인딩이라 `GatewayPorts` 불필요).
- 프록시는 IP 우회용이 아니라 **본래의 주거용 회선으로 정직하게 나가기** 위한 것. 수집량은 여전히 천천히
  (`CRAWL_MIN_REQ_MS`/`CRAWL_REQ_JITTER_MS`), 약관 범위 내에서.
