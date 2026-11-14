import * as XLSX from 'xlsx';
import {
  analyzeTimetableMatrix,
  type MergedCellSpan,
  type TimetableImportPreview,
} from './timetableGridParser';

export type { TimetableImportCellMeta, TimetableImportPreview } from './timetableGridParser';

export interface ParseExcelOptions {
  sheetName?: string;
}

export function parseTimetableFromExcelBuffer(
  buffer: ArrayBuffer | Uint8Array,
  options: ParseExcelOptions = {},
): TimetableImportPreview {
  const workbook = XLSX.read(buffer, { type: 'array' });
  const sheetNames = workbook.SheetNames ?? [];
  if (sheetNames.length === 0) {
    throw new Error('엑셀 파일에 읽을 수 있는 시트가 없습니다.');
  }

  const selectedSheetName =
    options.sheetName && sheetNames.includes(options.sheetName)
      ? options.sheetName
      : sheetNames[0];
  const sheet = workbook.Sheets[selectedSheetName];
  if (!sheet) {
    throw new Error('선택한 시트를 읽을 수 없습니다.');
  }

  const ref = sheet['!ref'];
  if (!ref) {
    throw new Error('선택한 시트가 비어 있습니다.');
  }

  const range = XLSX.utils.decode_range(ref);
  const maxRows = Math.min(range.e.r + 1, 60);
  const maxCols = Math.min(range.e.c + 1, 20);

  const grid: string[][] = Array.from({ length: maxRows }, () =>
    Array.from({ length: maxCols }, () => ''),
  );
  const mergedCells = new Map<string, MergedCellSpan>();

  for (let r = 0; r < maxRows; r++) {
    for (let c = 0; c < maxCols; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = sheet[addr];
      if (cell && cell.v !== undefined && cell.v !== null) {
        grid[r][c] = String(cell.w ?? cell.v).trim();
      }
    }
  }

  const merges = sheet['!merges'] ?? [];
  for (const merge of merges) {
    const masterVal = grid[merge.s.r]?.[merge.s.c] ?? '';
    const spanRows = merge.e.r - merge.s.r + 1;
    const spanCols = merge.e.c - merge.s.c + 1;
    for (let r = merge.s.r; r <= Math.min(merge.e.r, maxRows - 1); r++) {
      for (let c = merge.s.c; c <= Math.min(merge.e.c, maxCols - 1); c++) {
        if (!grid[r][c] && masterVal) {
          grid[r][c] = masterVal;
        }
        if (spanRows > 1 || spanCols > 1) {
          mergedCells.set(`${r}_${c}`, {
            masterRow: merge.s.r,
            masterCol: merge.s.c,
            spanRows,
            spanCols,
          });
        }
      }
    }
  }

  const warnings: string[] = [];
  if (sheetNames.length > 1) {
    warnings.push(
      `총 ${sheetNames.length}개 시트 중 '${selectedSheetName}' 시트를 분석했습니다.`,
    );
  }

  return analyzeTimetableMatrix({
    sourceType: 'excel',
    extractionMode: 'excel',
    grid,
    mergedCells,
    warnings,
    sheetNames,
    selectedSheetName,
  });
}
