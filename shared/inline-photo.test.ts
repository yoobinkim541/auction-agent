import { describe, expect, it } from 'vitest';
import { inlinePhotoDataUrl, isBase64Blob, repairStoredPhotoSource } from './inline-photo.ts';

describe('shared/inline-photo', () => {
  // Test vectors with magic bytes:
  // JPEG: /9j/
  const jpegBlob = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////' +
    '//////////////////////////////////////////////////////////////////////////////////////8=';
  // PNG: iVBORw0KGgo
  const pngBlob = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  // GIF: R0lGOD
  const gifBlob = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  // WebP: UklGR
  const webpBlob = 'UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

  describe('isBase64Blob', () => {
    it('유효한 base64 문자열이고 최소 길이를 넘으면 true', () => {
      expect(isBase64Blob(jpegBlob)).toBe(true);
      expect(isBase64Blob(pngBlob)).toBe(true);
    });

    it('공백이 포함되어 있어도 공백 제거 후 판정한다', () => {
      const spaced = `  ${jpegBlob.slice(0, 40)} \n ${jpegBlob.slice(40)}  `;
      expect(isBase64Blob(spaced)).toBe(true);
    });

    it('최소 길이(기본 80) 미만이면 false', () => {
      expect(isBase64Blob('iVBORw0KGgoAAAANSUhEUg==')).toBe(false);
      expect(isBase64Blob('iVBORw0KGgoAAAANSUhEUg==', 10)).toBe(true);
    });

    it('base64 외 특수문자가 포함되어 있으면 false', () => {
      expect(isBase64Blob(jpegBlob + '!@#$%^&*')).toBe(false);
    });
  });

  describe('inlinePhotoDataUrl', () => {
    it('JPEG 매직 바이트(/9j/)를 data:image/jpeg data URL로 변환한다', () => {
      const url = inlinePhotoDataUrl(jpegBlob);
      expect(url).toBe(`data:image/jpeg;base64,${jpegBlob}`);
    });

    it('PNG 매직 바이트(iVBORw0KGgo)를 data:image/png data URL로 변환한다', () => {
      const url = inlinePhotoDataUrl(pngBlob);
      expect(url).toBe(`data:image/png;base64,${pngBlob}`);
    });

    it('GIF 매직 바이트(R0lGOD)를 data:image/gif data URL로 변환한다', () => {
      const url = inlinePhotoDataUrl(gifBlob);
      expect(url).toBe(`data:image/gif;base64,${gifBlob}`);
    });

    it('WebP 매직 바이트(UklGR)를 data:image/webp data URL로 변환한다', () => {
      const url = inlinePhotoDataUrl(webpBlob);
      expect(url).toBe(`data:image/webp;base64,${webpBlob}`);
    });

    it('알려지지 않은 매직 바이트의 base64는 null을 반환한다', () => {
      const unknownBlob = 'AAAA'.repeat(30);
      expect(inlinePhotoDataUrl(unknownBlob)).toBeNull();
    });

    it('base64가 아니면 null을 반환한다', () => {
      expect(inlinePhotoDataUrl('https://example.com/test.jpg')).toBeNull();
    });
  });

  describe('repairStoredPhotoSource', () => {
    it('일반 HTTP URL은 그대로 유지한다', () => {
      const url = 'https://courtauction.go.kr/images/photo1.jpg';
      expect(repairStoredPhotoSource(url)).toBe(url);
    });

    it('경로에 알려진 base64 이미지가 붙은 URL은 data URL로 복구한다', () => {
      const damagedUrl = `https://courtauction.go.kr/${jpegBlob}`;
      expect(repairStoredPhotoSource(damagedUrl)).toBe(`data:image/jpeg;base64,${jpegBlob}`);
    });

    it('경로에 알 수 없는 base64 덩어리가 붙은 URL은 null로 반환해 무의미한 네트워크 요청을 방지한다', () => {
      const unknownBlob = 'X'.repeat(90);
      const damagedUrl = `https://courtauction.go.kr/${unknownBlob}`;
      expect(repairStoredPhotoSource(damagedUrl)).toBeNull();
    });
  });
});
