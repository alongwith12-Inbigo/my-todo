import JSZip from 'jszip';
import { DOMParser as XmlDomParser } from '@xmldom/xmldom';
import {
  analyzeTimetableMatrix,
  detectPeriodFromLabel,
  detectWeekdayFromHeader,
  type MergedCellSpan,
  type TimetableImportPreview,
  type TimetableTableOption,
} from './timetableGridParser';

export interface HwpxExtractedTable {
  id: string;
  label: string;
  grid: string[][];
  mergedCells: Map<string, MergedCellSpan>;
  rowCount: number;
  colCount: number;
  weekdayMatchCount: number;
  periodMatchCount: number;
  score: number;
}

function parseXmlDocument(xmlText: string): Document {
  if (typeof globalThis.DOMParser !== 'undefined') {
    return new globalThis.DOMParser().parseFromString(xmlText, 'text/xml');
  }
  return new XmlDomParser().parseFromString(xmlText, 'text/xml') as unknown as Document;
}

function getDirectChildrenByLocalName(parent: Element, localName: string): Element[] {
  const result: Element[] = [];
  const children = parent.childNodes;
  for (let i = 0; i < children.length; i++) {
    const node = children[i];
    if (node.nodeType === 1) {
      const el = node as Element;
      const name = el.localName || el.nodeName.replace(/^[^:]+:/, '');
      if (name === localName) {
        result.push(el);
      }
    }
  }
  return result;
}

function getDescendantsByLocalName(root: Element | Document, localName: string): Element[] {
  const result: Element[] = [];
  const all = root.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    const name = el.localName || el.nodeName.replace(/^[^:]+:/, '');
    if (name === localName) {
      result.push(el);
    }
  }
  return result;
}

function getAttr(el: Element, attrName: string): string | null {
  return el.getAttribute(attrName) ?? el.getAttribute(`hp:${attrName}`) ?? null;
}

function extractCellTextFromTc(tc: Element): string {
  const paragraphs = getDescendantsByLocalName(tc, 'p');
  if (paragraphs.length === 0) {
    const textNodes = getDescendantsByLocalName(tc, 't');
    return textNodes
      .map((t) => (t.textContent ?? '').trim())
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  const lines: string[] = [];
  for (const p of paragraphs) {
    const textNodes = getDescendantsByLocalName(p, 't');
    const line = textNodes
      .map((t) => t.textContent ?? '')
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    if (line) {
      lines.push(line);
    }
  }
  return lines.join('\n').trim();
}

function extractSingleHwpxTable(tbl: Element, index: number): HwpxExtractedTable | null {
  // Ignore nested tables inside cells when scanning direct tr children
  const trList = getDirectChildrenByLocalName(tbl, 'tr');
  if (trList.length === 0) return null;

  interface CellPlacement {
    row: number;
    col: number;
    rowSpan: number;
    colSpan: number;
    text: string;
  }

  const placements: CellPlacement[] = [];
  const occupied = new Set<string>();
  let maxRow = 0;
  let maxCol = 0;

  trList.forEach((tr, rowIdxFallback) => {
    const tcList = getDirectChildrenByLocalName(tr, 'tc');
    let nextFallbackCol = 0;

    for (const tc of tcList) {
      const cellAddrEls = getDirectChildrenByLocalName(tc, 'cellAddr');
      const cellSpanEls = getDirectChildrenByLocalName(tc, 'cellSpan');

      const addrColAttr = cellAddrEls[0] ? getAttr(cellAddrEls[0], 'colAddr') : null;
      const addrRowAttr = cellAddrEls[0] ? getAttr(cellAddrEls[0], 'rowAddr') : null;
      const colSpanAttr = cellSpanEls[0] ? getAttr(cellSpanEls[0], 'colSpan') : null;
      const rowSpanAttr = cellSpanEls[0] ? getAttr(cellSpanEls[0], 'rowSpan') : null;

      const rowSpan = Math.max(1, Number(rowSpanAttr ?? 1) || 1);
      const colSpan = Math.max(1, Number(colSpanAttr ?? 1) || 1);

      let row = addrRowAttr !== null ? Number(addrRowAttr) : rowIdxFallback;
      let col = addrColAttr !== null ? Number(addrColAttr) : -1;

      if (!Number.isInteger(row) || row < 0) row = rowIdxFallback;
      if (!Number.isInteger(col) || col < 0) {
        while (occupied.has(`${row}_${nextFallbackCol}`)) {
          nextFallbackCol += 1;
        }
        col = nextFallbackCol;
      }

      for (let rr = row; rr < row + rowSpan; rr++) {
        for (let cc = col; cc < col + colSpan; cc++) {
          occupied.add(`${rr}_${cc}`);
        }
      }
      nextFallbackCol = col + colSpan;

      maxRow = Math.max(maxRow, row + rowSpan);
      maxCol = Math.max(maxCol, col + colSpan);

      placements.push({
        row,
        col,
        rowSpan,
        colSpan,
        text: extractCellTextFromTc(tc),
      });
    }
  });

  if (maxRow === 0 || maxCol === 0) return null;

  const grid: string[][] = Array.from({ length: maxRow }, () =>
    Array.from({ length: maxCol }, () => ''),
  );
  const mergedCells = new Map<string, MergedCellSpan>();

  for (const item of placements) {
    for (let r = item.row; r < item.row + item.rowSpan; r++) {
      for (let c = item.col; c < item.col + item.colSpan; c++) {
        grid[r][c] = item.text;
        if (item.rowSpan > 1 || item.colSpan > 1) {
          mergedCells.set(`${r}_${c}`, {
            masterRow: item.row,
            masterCol: item.col,
            spanRows: item.rowSpan,
            spanCols: item.colSpan,
          });
        }
      }
    }
  }

  let bestWeekdayMatchCount = 0;
  for (let r = 0; r < maxRow; r++) {
    const days = new Set<number>();
    for (let c = 0; c < maxCol; c++) {
      const d = detectWeekdayFromHeader(grid[r][c]);
      if (d) days.add(d);
    }
    bestWeekdayMatchCount = Math.max(bestWeekdayMatchCount, days.size);
  }

  let periodMatchCount = 0;
  for (let r = 0; r < maxRow; r++) {
    for (let c = 0; c < Math.min(2, maxCol); c++) {
      if (detectPeriodFromLabel(grid[r][c])) {
        periodMatchCount += 1;
        break;
      }
    }
  }

  const score = bestWeekdayMatchCount * 10 + periodMatchCount * 2;
  const label = `표 ${index + 1} (${maxRow}행 × ${maxCol}열${
    bestWeekdayMatchCount > 0 ? ` · 요일 ${bestWeekdayMatchCount}개 일치` : ''
  })`;

  return {
    id: `hwpx_table_${index}`,
    label,
    grid,
    mergedCells,
    rowCount: maxRow,
    colCount: maxCol,
    weekdayMatchCount: bestWeekdayMatchCount,
    periodMatchCount,
    score,
  };
}

export function extractTablesFromHwpxSectionXmls(
  sectionXmlStrings: string[],
): HwpxExtractedTable[] {
  const tables: HwpxExtractedTable[] = [];
  for (const xmlStr of sectionXmlStrings) {
    const doc = parseXmlDocument(xmlStr);
    const tblElements = getDescendantsByLocalName(doc, 'tbl');
    for (const tbl of tblElements) {
      // Skip nested tables whose ancestor is another <tbl>
      let parent = tbl.parentNode as Element | null;
      let isNested = false;
      while (parent && parent.nodeType === 1) {
        const pName = parent.localName || parent.nodeName.replace(/^[^:]+:/, '');
        if (pName === 'tbl') {
          isNested = true;
          break;
        }
        parent = parent.parentNode as Element | null;
      }
      if (isNested) continue;

      const parsed = extractSingleHwpxTable(tbl, tables.length);
      if (parsed && parsed.rowCount >= 2 && parsed.colCount >= 2) {
        tables.push(parsed);
      }
    }
  }
  return tables;
}

export async function extractTablesFromHwpxBuffer(
  buffer: ArrayBuffer | Uint8Array,
): Promise<HwpxExtractedTable[]> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new Error(
      'HWPX 압축 구조를 열 수 없습니다. 손상되지 않은 .hwpx 파일인지 확인해 주세요. (구형 .hwp 파일은 HWPX 또는 PDF로 다시 저장 후 업로드해 주세요.)',
    );
  }

  const sectionEntries = Object.keys(zip.files)
    .filter((name) => /^contents\/section\d+\.xml$/i.test(name))
    .sort((a, b) => {
      const numA = Number(/section(\d+)\.xml/i.exec(a)?.[1] ?? 0);
      const numB = Number(/section(\d+)\.xml/i.exec(b)?.[1] ?? 0);
      return numA - numB;
    });

  if (sectionEntries.length === 0) {
    throw new Error(
      'HWPX 문서에서 본문 XML(Contents/section*.xml)을 찾지 못했습니다. 한글 프로그램에서 HWPX 형식으로 다시 저장한 뒤 시도해 주세요.',
    );
  }

  const xmlStrings = await Promise.all(
    sectionEntries.map((entry) => zip.files[entry].async('string')),
  );

  const tables = extractTablesFromHwpxSectionXmls(xmlStrings);
  if (tables.length === 0) {
    throw new Error(
      'HWPX 문서 안에서 시간표로 분석할 수 있는 표(<hp:tbl>)를 찾지 못했습니다.',
    );
  }

  return tables;
}

export function buildHwpxPreviewFromTables(
  tables: HwpxExtractedTable[],
  selectedTableId?: string,
): TimetableImportPreview {
  if (tables.length === 0) {
    throw new Error('분석할 수 있는 표가 없습니다.');
  }

  const sortedByBest = [...tables].sort((a, b) => b.score - a.score);
  const chosen =
    (selectedTableId && tables.find((t) => t.id === selectedTableId)) ||
    sortedByBest[0];

  const tableOptions: TimetableTableOption[] = tables.map((t) => ({
    id: t.id,
    label: t.label,
    rowCount: t.rowCount,
    colCount: t.colCount,
    weekdayMatchCount: t.weekdayMatchCount,
  }));

  const warnings: string[] = [];
  if (tables.length > 1) {
    warnings.push(
      `문서에서 ${tables.length}개의 표를 찾았습니다. 시간표가 아니라면 상단 '표 선택'에서 다른 표를 선택해 주세요.`,
    );
  }

  return analyzeTimetableMatrix({
    sourceType: 'hwpx',
    extractionMode: 'hwpx_xml',
    grid: chosen.grid,
    mergedCells: chosen.mergedCells,
    warnings,
    tableOptions,
    selectedTableId: chosen.id,
  });
}

export async function parseTimetableFromHwpxBuffer(
  buffer: ArrayBuffer | Uint8Array,
  options: { tableId?: string } = {},
): Promise<{
  tables: HwpxExtractedTable[];
  preview: TimetableImportPreview;
}> {
  const tables = await extractTablesFromHwpxBuffer(buffer);
  const preview = buildHwpxPreviewFromTables(tables, options.tableId);
  return { tables, preview };
}
