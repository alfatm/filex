import type { AssistantReport } from '@/data/types';

/** Long enough for the browser to have picked the object URL up before it is released; Firefox needs the delay. */
const REVOKE_DELAY_MS = 1000;
const FILE_NAME_MAX = 80;
/** A byte-order mark: spreadsheets read the file as UTF-8 only when it starts with one. */
const BOM = String.fromCharCode(0xfeff);

const CSV_COLUMNS = ['path', 'name', 'kind', 'size', 'modified'] as const;

/** One cell, quoted when it holds a comma, a quote or a line break, as RFC 4180 has it. */
function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The rows as CSV: a header, one line per file. The text is not a table and stays out. */
export function reportCsv(report: AssistantReport): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const { node } of report.rows) {
    lines.push([node.id, node.name, node.kind, node.kind === 'file' ? node.size : '', node.modifiedAt ?? ''].map(csvCell).join(','));
  }
  return `${BOM}${lines.join('\r\n')}\r\n`;
}

/** The report as plain text: the title, the text, then one address per line. */
export function reportText(report: AssistantReport): string {
  const parts = [report.title];
  if (report.text) parts.push('', report.text);
  if (report.rows.length) parts.push('', ...report.rows.map((hit) => hit.node.id));
  return `${parts.join('\n')}\n`;
}

/** A file name from the title: whatever a file system refuses becomes a space; an empty title is "report". */
export function reportFileName(report: AssistantReport, ext: 'txt' | 'csv'): string {
  const base = report.title.replace(/[\\/:*?"<>|\p{Cc}]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, FILE_NAME_MAX) || 'report';
  return `${base}.${ext}`;
}

/** Hands the browser a file to save, built here rather than fetched: the report never existed on the server as a file. */
export function saveReport(content: string, name: string, mime: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}
