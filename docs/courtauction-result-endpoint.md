# courtauction 경매사건검색(과거/종결 사건 결과) 엔드포인트 — S1 캡처 결과

진행물건 상세(`/pgj/pgj15B/selectAuctnCsSrchRslt.on`)는 활성 검색 컨텍스트라 **과거/종결 사건은 빈 응답**.
반면 **경매사건검색(사건번호 조회)** 은 `pgj15A` 엔드포인트로 **종결 후에도 낙찰가·결과**를 돌려준다.

## 발견 경로
메뉴 `PGJ111M01` → `fastSrchMoveUrl("4")` → `PGJ159M00`(경매사건검색) → 검색 시 `PGJ15AF01`로 이동,
`{cortOfcCd, csNo}` param으로 `sbm_selectCsDtlInf` 제출.

## 요청
```
POST /pgj/pgj15A/selectAuctnCsSrchRslt.on
headers: submissionid: mf_wfm_mainFrame_sbm_selectCsDtlInf · sc-userid: SYSTEM
         referer: .../pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ15AF01.xml
body: { "dma_srchCsDtlInf": { "cortOfcCd": "B000210", "csNo": "2023타경111644" } }
```
- `cortOfcCd` = 법원코드(METRO_COURTS, `courtCodeByName`), `csNo` = 표시형 "YYYY타경NNNNNN".

## 응답 (`res.data`)
- `dma_csBasInf` — 사건기본(csNo, csNm 등).
- **`dlt_dspslGdsDspslObjctLst[]`** — 물건별:
  - `aeeEvlAmt` 감정가 · **`dspslAmt` 낙찰가(매각 시)** · `dspslDxdyYmd` 매각기일(YYYYMMDD)
  - `fstPbancLwsDspslPrc`…`fothPbancLwsDspslPrc` 차수별 최저매각가 · `gdsDspslProgYn` 진행여부
  - `auctnDxdyGdsStatCd` 상태 · `dspslGdsSeq` 물건순번(=item) · `rprsLtnoAddr` 주소
- **`dlt_rletCsGdsDtsDxdyInf[]`** — 기일내역: `dxdyYmd` · `auctnDxdyKndCd`(01 매각기일/02 매각결정기일) · **`auctnDxdyRsltCd`(001 매각/002 유찰)**

## 검증 사례
`B000210` / `2023타경111644`: 감정 416,500,000 → **낙찰 477,000,000**(낙찰가율 114.5%), 매각기일 20260625, 결과 001(매각).
→ 동일 사건이 `pgj15B`에선 빈 응답, **`pgj15A`에선 정상 반환**.

## 한계
- **응찰자수(bidder count) 미포함** — 이 엔드포인트에도 없음. (경쟁신호는 `inq/interest`(관심수)로 대체.) 개찰결과는 별도 PDF/미공개 추정.
- 결과코드: 001=매각, 002=유찰 확인. 변경/취하/정지 등은 사례 축적 시 매핑 보강.

## S2 사용 계획
`fetchCaseResult(caseNo, cortOfcCd)` → 위 응답 파싱 → `gm_auction_results`(낙찰가·결과·기일) 적재 + 유찰 시 차기기일로 `gm_listings.sale_date` 백필. 매각기일 지났는데 결과 미수집인 사건을 이 엔드포인트로 소급 수집.
