export interface BrowserOcrResult {
  text: string;
  confidence: number;
  lowConfidence: boolean;
}

export interface BrowserOcrProgress {
  status: string;
  progress: number; // 0..100
}

const SUPPORTED_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/bmp',
]);

export const OCR_MAX_FILE_BYTES = 15 * 1024 * 1024; // 15MB

export function validateOcrImageFile(file: File): string | null {
  if (!file.type || !SUPPORTED_IMAGE_TYPES.has(file.type.toLowerCase())) {
    return 'PNG, JPG, WEBP, BMP 형식의 이미지 파일만 지원합니다.';
  }
  if (file.size <= 0) {
    return '비어 있는 이미지 파일입니다.';
  }
  if (file.size > OCR_MAX_FILE_BYTES) {
    return '이미지 용량은 15MB 이하만 처리할 수 있습니다.';
  }
  return null;
}

export function isBrowserOcrSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof Worker !== 'undefined' &&
    typeof WebAssembly !== 'undefined'
  );
}

function mapOcrStatusToKorean(status: string): string {
  switch (status) {
    case 'loading tesseract core':
      return 'OCR 엔진 불러오는 중';
    case 'initializing tesseract':
      return 'OCR 엔진 초기화 중';
    case 'loading language traineddata':
      return '한국어·영어 인식 데이터 준비 중';
    case 'initializing api':
      return '인식 준비 중';
    case 'recognizing text':
      return '이미지에서 글자 인식 중';
    default:
      return '이미지 처리 중';
  }
}

export async function runInBrowserOcr(
  imageSource: File | Blob | string,
  options: {
    onProgress?: (progress: BrowserOcrProgress) => void;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<BrowserOcrResult> {
  if (!isBrowserOcrSupported()) {
    throw new Error(
      '현재 브라우저는 로컬 WebAssembly OCR을 지원하지 않습니다. 오른쪽 입력 칸에 텍스트를 직접 입력해 주세요.',
    );
  }

  if (options.signal?.aborted) {
    throw new Error('OCR 분석이 취소되었습니다.');
  }

  const { createWorker } = await import('tesseract.js');
  const timeoutMs = options.timeoutMs ?? 60_000;

  let worker: Awaited<ReturnType<typeof createWorker>> | null = null;
  let aborted = false;
  let timedOut = false;

  const terminateWorker = async () => {
    const active = worker;
    worker = null;
    if (active) {
      try {
        await active.terminate();
      } catch {
        // Ignore termination cleanup errors
      }
    }
  };

  const handleAbort = () => {
    aborted = true;
    void terminateWorker();
  };

  options.signal?.addEventListener('abort', handleAbort);
  const timeoutId = window.setTimeout(() => {
    timedOut = true;
    void terminateWorker();
  }, timeoutMs);

  try {
    worker = await createWorker('kor+eng', 1, {
      logger: (msg) => {
        if (!options.onProgress) return;
        const pct = Math.min(100, Math.max(0, Math.round((msg.progress ?? 0) * 100)));
        options.onProgress({
          status: mapOcrStatusToKorean(msg.status || ''),
          progress: pct,
        });
      },
      errorHandler: () => {
        // Errors propagate through rejected promises below
      },
    });

    if (aborted) {
      throw new Error('OCR 분석이 취소되었습니다.');
    }

    const result = await worker.recognize(imageSource);
    const cleanedText = (result.data?.text ?? '')
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    const confidence = Number(result.data?.confidence ?? 0);
    const lowConfidence = cleanedText.length < 4 || confidence < 55;

    return {
      text: cleanedText,
      confidence,
      lowConfidence,
    };
  } catch (err) {
    if (aborted) {
      throw new Error('OCR 분석이 취소되었습니다.');
    }
    if (timedOut) {
      throw new Error(
        'OCR 인식 시간이 초과되었습니다. 네트워크에서 한국어 인식 데이터 로드가 차단되었거나 이미지가 너무 클 수 있습니다. 텍스트 직접 입력을 이용해 주세요.',
      );
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `브라우저 OCR 실행 중 문제가 발생했습니다 (${detail}). 이미지를 참고해 텍스트를 직접 입력하거나 다시 시도해 주세요.`,
    );
  } finally {
    window.clearTimeout(timeoutId);
    options.signal?.removeEventListener('abort', handleAbort);
    await terminateWorker();
  }
}
