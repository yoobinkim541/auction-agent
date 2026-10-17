/**
 * 기일입찰표 오기 방지 검증 및 제출 서류 생성기.
 *
 * 실제 경매 법정의 기일입찰표 서식 규격에 맞춰 금액을 한글과 자릿수 칸별로 분해하고,
 * 최저매각가격 미만 무효 입찰이나 감정가 초과 입찰을 사전에 방지한다.
 */
export const BID_BOX_COLUMNS = [
  '조',
  '천억',
  '백억',
  '십억',
  '억',
  '천만',
  '백만',
  '십만',
  '만',
  '천',
  '백',
  '십',
  '일',
] as const;

export type BidBoxColumn = (typeof BID_BOX_COLUMNS)[number];

const HANGEUL_DIGITS = ['', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'];
const HANGEUL_SUB_UNITS = ['', '십', '백', '천'];
const HANGEUL_BIG_UNITS = ['', '만', '억', '조'];

export function numberToKoreanHangeulAmount(amount: number): string {
  if (!amount || !Number.isFinite(amount) || amount <= 0) return '영 원';

  let n = Math.floor(amount);
  const parts: string[] = [];
  let unitIndex = 0;

  while (n > 0 && unitIndex < HANGEUL_BIG_UNITS.length) {
    const chunk = n % 10000;
    if (chunk > 0) {
      let chunkStr = '';
      let sub = chunk;
      for (let i = 0; i < 4; i++) {
        const digit = sub % 10;
        if (digit > 0) {
          // 십 단위에서 1은 '일십' 대신 '십'으로 자연스럽게 표기
          const prefix = digit === 1 && i === 1 ? '' : HANGEUL_DIGITS[digit]!;
          chunkStr = `${prefix}${HANGEUL_SUB_UNITS[i]!}${chunkStr}`;
        }
        sub = Math.floor(sub / 10);
      }
      const unit = HANGEUL_BIG_UNITS[unitIndex]!;
      parts.unshift(unit ? `${chunkStr}${unit}` : chunkStr);
    }
    n = Math.floor(n / 10000);
    unitIndex++;
  }

  return `${parts.join(' ')} 원`;
}

export function bidBoxDigits(amount: number): Record<BidBoxColumn, number | null> {
  const result: Record<string, number | null> = {};
  const str = Math.floor(Math.max(0, amount)).toString();
  const digits = str.split('').map((d) => parseInt(d, 10));

  // 13개 박스 채우기 (오른쪽 '일' 자리부터 역순)
  for (let i = 0; i < BID_BOX_COLUMNS.length; i++) {
    const colName = BID_BOX_COLUMNS[BID_BOX_COLUMNS.length - 1 - i]!;
    if (i < digits.length) {
      result[colName] = digits[digits.length - 1 - i]!;
    } else {
      result[colName] = null;
    }
  }

  return result as Record<BidBoxColumn, number | null>;
}

export interface BidValidationResult {
  isValid: boolean;
  error?: string;
  warnings: string[];
}

export function validateBidAmount(
  bidAmount: number,
  minBidPrice: number,
  appraisalValue?: number,
): BidValidationResult {
  const warnings: string[] = [];

  if (!Number.isFinite(bidAmount) || bidAmount < minBidPrice) {
    return {
      isValid: false,
      error: `입찰가(${bidAmount.toLocaleString('ko-KR')}원)가 최저매각가격(${minBidPrice.toLocaleString('ko-KR')}원) 미만이므로 법원에서 즉시 무효 처리됩니다.`,
      warnings,
    };
  }

  if (appraisalValue && bidAmount > appraisalValue) {
    warnings.push(
      `입찰가가 감정가(${appraisalValue.toLocaleString('ko-KR')}원) 초과(감정가 초과)입니다. 고가 낙찰 위험이 있는지 권리분석을 재확인하세요.`,
    );
  }

  return {
    isValid: true,
    warnings,
  };
}

export type BidderType = 'individual' | 'proxy' | 'corporation' | 'corporation_proxy';

export function requiredBidDocuments(bidderType: BidderType, isFarmLand = false): string[] {
  const docs: string[] = [];

  switch (bidderType) {
    case 'individual':
      docs.push('본인 신분증 (주민등록증, 운전면허증, 여권 중 1)');
      docs.push('본인 도장 (인감도장 또는 막도장)');
      docs.push('매수신청보증금 (최저매각가의 10% 또는 20%, 은행 자기앞수표 1매 권장)');
      break;
    case 'proxy':
      docs.push('본인(위임자) 인감증명서 1부 (발급 3개월 이내)');
      docs.push('본인 인감도장이 날인된 위임장 1부 (법정 비치 또는 사전 작성)');
      docs.push('대리인 신분증 및 대리인 도장');
      docs.push('매수신청보증금 (자기앞수표 권장)');
      break;
    case 'corporation':
      docs.push('법인등기부등본 1부 (말소사항 포함, 발급 3개월 이내)');
      docs.push('법인인감증명서 1부 및 법인인감도장 (또는 사용인감계+사용인감)');
      docs.push('대표자 신분증');
      docs.push('매수신청보증금 (자기앞수표 권장)');
      break;
    case 'corporation_proxy':
      docs.push('법인등기부등본 1부 및 법인인감증명서 1부 (3개월 이내)');
      docs.push('법인인감도장이 날인된 위임장 1부');
      docs.push('대리인 신분증 및 대리인 도장');
      docs.push('매수신청보증금 (자기앞수표 권장)');
      break;
  }

  if (isFarmLand) {
    docs.push('⚠️ 농지취득자격증명(농취증) 필수: 매각결정기일(낙찰 후 7일 이내)까지 법원에 미제출 시 보증금 몰수');
  }

  return docs;
}
