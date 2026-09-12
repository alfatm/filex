import { describe, expect, it } from 'vitest';
import type { AssistantReport, SearchHit } from '@/data/types';
import { reportCsv, reportFileName, reportText } from './report';

const row = (id: string, name: string, extra: Partial<SearchHit['node']> = {}): SearchHit =>
  ({ node: { id, name, kind: 'file', size: 12, modifiedAt: '2026-07-01T10:00:00.000Z', ...extra }, storageId: 'main', folderPath: '' }) as SearchHit;

const report: AssistantReport = {
  title: 'Q1 files',
  text: 'Everything from the quarter.',
  rows: [row('main://Docs/a.pdf', 'a.pdf'), row('main://Docs/b, "final".txt', 'b, "final".txt', { modifiedAt: undefined }), row('main://Docs', 'Docs', { kind: 'folder', size: 0 })],
};

describe('report', () => {
  it('writes the rows as CSV with a BOM, a header, and quoting where a cell needs it', () => {
    const csv = reportCsv(report);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1).split('\r\n')).toEqual([
      'path,name,kind,size,modified',
      'main://Docs/a.pdf,a.pdf,file,12,2026-07-01T10:00:00.000Z',
      // A comma and quotes in a name: the cell is quoted and the quotes doubled. A missing date is an empty cell.
      '"main://Docs/b, ""final"".txt","b, ""final"".txt",file,12,',
      // A folder has no size.
      'main://Docs,Docs,folder,,2026-07-01T10:00:00.000Z',
      '',
    ]);
  });

  it('writes the text form as the title, the text, then one address per line', () => {
    expect(reportText(report)).toBe('Q1 files\n\nEverything from the quarter.\n\nmain://Docs/a.pdf\nmain://Docs/b, "final".txt\nmain://Docs\n');
    expect(reportText({ title: 'Note', text: 'Just words.', rows: [] })).toBe('Note\n\nJust words.\n');
  });

  it('names the file after the title, minus what a file system refuses', () => {
    expect(reportFileName(report, 'csv')).toBe('Q1 files.csv');
    expect(reportFileName({ title: 'a/b: "c"?', rows: [] }, 'txt')).toBe('a b c.txt');
    expect(reportFileName({ title: '   ', rows: [] }, 'txt')).toBe('report.txt');
  });
});
