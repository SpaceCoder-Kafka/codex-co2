import ExcelJS from 'exceljs/dist/exceljs.min.js';
import { unpackOffice, validatePackageXml } from './office-preview.mjs';
self.onmessage = async event => {
  try {
    const bytes = event.data, entries = unpackOffice(bytes); validatePackageXml(entries, { rejectExternal: true });
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(bytes);
    let cells = 0, truncated = false;
    const sheets = [];
    const value = cell => {
      const v = cell.value;
      if (v === null || v === undefined) return '';
      if (v instanceof Date) return v.toISOString().slice(0, 10);
      if (typeof v !== 'object') return String(v);
      if (v.formula || v.sharedFormula) return v.result === undefined ? `=${v.formula || v.sharedFormula}（未保存计算结果）` : String(v.result);
      if (v.richText) return v.richText.map(p => p.text).join('');
      if (v.text !== undefined) return String(v.text);
      if (v.error) return String(v.error);
      return '';
    };
    for (const worksheet of workbook.worksheets.slice(0, 100)) {
      const rows = []; let stopped = false;
      worksheet.eachRow({ includeEmpty: false }, (row, index) => {
        if (stopped) return;
        if (index > 20000 || row.cellCount > 1000 || cells + row.cellCount > 100000) { truncated = stopped = true; return; }
        const line = [];
        for (let c = 1; c <= row.cellCount; c++) { const text = value(row.getCell(c)); if (text.length > 65536) { truncated = true; line.push(text.slice(0, 65536) + '…'); } else line.push(text); }
        cells += line.length; rows.push(line);
      });
      sheets.push({ name: worksheet.name, rows });
    }
    if (workbook.worksheets.length > 100) truncated = true;
    if (!sheets.length) sheets.push({ name: '空工作簿', rows: [] });
    self.postMessage({ sheets, truncated });
  } catch (error) { self.postMessage({ error: error.message || '无法解析 Excel 文件' }); }
};
