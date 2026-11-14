import { useId, useRef } from 'react';
import { Image as ImageIcon, RefreshCw, ScanText, X } from 'lucide-react';
import type { BrowserOcrProgress } from '../../lib/ocrProcessor';

interface ImportImageOcrBoxProps {
  imageFile: File;
  imagePreviewUrl: string;
  ocrSupported: boolean;
  ocrRunning: boolean;
  ocrProgress: BrowserOcrProgress | null;
  ocrConfidence: number | null;
  ocrLowQuality: boolean;
  ocrError: string | null;
  ocrEditedText: string;
  onChangeText: (nextText: string) => void;
  onReplaceImage: (file: File | null) => void;
  onClearImage: () => void;
  onRerunOcr: () => void;
  onCancelOcr: () => void;
  onAnalyze: () => void;
}

export function ImportImageOcrBox({
  imageFile,
  imagePreviewUrl,
  ocrSupported,
  ocrRunning,
  ocrProgress,
  ocrConfidence,
  ocrLowQuality,
  ocrError,
  ocrEditedText,
  onChangeText,
  onReplaceImage,
  onClearImage,
  onRerunOcr,
  onCancelOcr,
  onAnalyze,
}: ImportImageOcrBoxProps) {
  const replaceInputId = useId();
  const textareaId = useId();
  const replaceInputRef = useRef<HTMLInputElement | null>(null);

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs text-slate-700 min-w-0">
          <ImageIcon className="w-4 h-4 text-teal-700 shrink-0" aria-hidden="true" />
          <span className="font-semibold text-slate-900">첨부한 이미지</span>
          <span aria-hidden="true" className="text-slate-400">
            ·
          </span>
          <span className="truncate max-w-[240px] text-slate-600">
            {imageFile.name || '붙여넣은 캡처 이미지'}
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <label
            htmlFor={replaceInputId}
            className="px-2.5 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 whitespace-nowrap cursor-pointer"
          >
            다른 이미지
          </label>
          <input
            ref={replaceInputRef}
            id={replaceInputId}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/bmp"
            onChange={(e) => {
              onReplaceImage(e.target.files?.[0] ?? null);
              if (replaceInputRef.current) replaceInputRef.current.value = '';
            }}
            className="sr-only"
          />

          <button
            type="button"
            onClick={onClearImage}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-600 bg-white border border-slate-200 rounded-md hover:text-red-700 hover:border-red-200 whitespace-nowrap cursor-pointer"
          >
            <X className="w-3.5 h-3.5" aria-hidden="true" />
            <span>이미지 제거</span>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
        {/* Left: Image Preview + OCR Progress */}
        <div className="space-y-2.5">
          <div className="border border-slate-200 rounded-lg overflow-hidden bg-white">
            <img
              src={imagePreviewUrl}
              alt="업로드한 학교 안내문 이미지 미리보기"
              className="w-full max-h-64 object-contain mx-auto"
            />
          </div>

          {ocrRunning && ocrProgress && (
            <div
              role="status"
              className="p-2.5 rounded-lg border border-slate-200 bg-white space-y-1.5"
            >
              <div className="flex items-center justify-between text-xs text-slate-700 tabular-nums">
                <span>{ocrProgress.status}...</span>
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{ocrProgress.progress}%</span>
                  <button
                    type="button"
                    onClick={onCancelOcr}
                    className="text-red-700 hover:underline font-medium cursor-pointer"
                  >
                    중단
                  </button>
                </div>
              </div>
              <div className="h-1.5 bg-slate-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-teal-700 transition-all duration-150"
                  style={{ width: `${ocrProgress.progress}%` }}
                />
              </div>
            </div>
          )}

          {!ocrRunning && ocrSupported && (
            <div className="flex items-center justify-between gap-2 text-xs text-slate-500">
              <span>브라우저 내부에서 글자를 인식하며 서버로 전송되지 않습니다.</span>
              <button
                type="button"
                onClick={onRerunOcr}
                className="inline-flex items-center gap-1 text-xs font-medium text-teal-800 hover:text-teal-950 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <RefreshCw className="w-3 h-3" aria-hidden="true" />
                <span>다시 인식</span>
              </button>
            </div>
          )}

          {ocrError && (
            <div
              role="alert"
              className="p-2.5 rounded-lg border border-red-200 bg-red-50 text-xs text-red-800"
            >
              {ocrError}
            </div>
          )}
        </div>

        {/* Right: Editable Extracted Text + Analyze Trigger */}
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label
              htmlFor={textareaId}
              className="text-xs font-bold text-slate-900"
            >
              이미지에서 추출된 텍스트 (수정 가능)
            </label>
            {ocrConfidence !== null && (
              <span className="text-xs text-slate-500 tabular-nums">
                인식 신뢰도 {ocrConfidence}%
              </span>
            )}
          </div>

          {ocrLowQuality && (
            <div
              role="status"
              className="p-2 rounded-lg border border-amber-200 bg-amber-50 text-xs text-amber-950"
            >
              일부 글자가 부정확할 수 있습니다. 왼쪽 이미지를 보며 날짜·시간·제목을 다듬은 뒤 분석해 주세요.
            </div>
          )}

          <textarea
            id={textareaId}
            rows={7}
            maxLength={10000}
            value={ocrEditedText}
            onChange={(e) => onChangeText(e.target.value)}
            placeholder={
              ocrRunning
                ? '이미지에서 글자를 읽고 있습니다...'
                : '추출된 텍스트가 여기에 표시됩니다. 인식이 부족한 부분은 왼쪽 이미지를 보고 직접 입력·수정할 수 있습니다.'
            }
            className="w-full px-3 py-2 text-sm leading-relaxed border border-slate-300 rounded-lg bg-white focus:outline-none focus:border-teal-700"
          />

          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] text-slate-500">
              분석 후 업무·일정 후보를 선택 등록할 수 있습니다.
            </span>

            <div className="flex items-center gap-2 shrink-0">
              {ocrEditedText && (
                <button
                  type="button"
                  onClick={() => onChangeText('')}
                  className="px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 whitespace-nowrap cursor-pointer"
                >
                  텍스트 지우기
                </button>
              )}

              <button
                type="button"
                disabled={ocrRunning || !ocrEditedText.trim()}
                onClick={onAnalyze}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold bg-teal-700 text-white rounded-lg hover:bg-teal-800 disabled:opacity-50 whitespace-nowrap cursor-pointer"
              >
                <ScanText className="w-3.5 h-3.5" aria-hidden="true" />
                <span>내용 분석</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
