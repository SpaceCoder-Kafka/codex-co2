import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { unpackOffice, packageTarget, rasterMime, OFFICE_LIMITS, officeXml, validatePackageXml } from '../public/office-preview.mjs';
import { decodePreviewText, parseTable } from '../public/preview-renderers.mjs';

const archive = files => zipSync({ '[Content_Types].xml': strToU8('<Types/>'), ...files });
test('Office ZIP reads bounded package contents without trusting paths or size metadata', () => {
  const files = new Map(unpackOffice(archive({ 'word/document.xml': strToU8('<document>合成</document>'), 'word/media/image.png': new Uint8Array([1, 2]) })));
  assert.match(new TextDecoder().decode(files.get('word/document.xml')), /合成/);
  for (const name of ['../outside.xml', '/absolute.xml', 'word/../../escape.xml', 'word\\document.xml']) assert.throws(() => unpackOffice(archive({ [name]: strToU8('<x/>') })), /无效/);
  assert.throws(() => unpackOffice(archive({ 'word/document.xml': new Uint8Array(OFFICE_LIMITS.entry + 1) })), /解压/);
  assert.throws(() => unpackOffice(new Uint8Array([1, 2, 3])), /Office|zip|unexpected/i);
});
test('Office package relationships stay inside the selected ZIP and never become host or network paths', () => {
  assert.equal(packageTarget('ppt/slides/slide1.xml', '../media/image.png'), 'ppt/media/image.png');
  for (const value of ['https://example.invalid/a', '/private/file', '../../../escape', 'file:///secret', 'x\\y']) assert.equal(packageTarget('ppt/slides/slide1.xml', value), null);
  const parser = { parseFromString() { throw Error('XML parser must not see a DTD'); } };
  assert.throws(() => officeXml(strToU8('<!DOCTYPE x [<!ENTITY x SYSTEM "file:///secret">]><x/>'), parser), /实体/);
});
test('embedded images check signatures and decoded dimensions before browser decoding', () => {
  const png = new Uint8Array(24); png.set([137, 80, 78, 71]); const view = new DataView(png.buffer); view.setUint32(16, 100); view.setUint32(20, 100);
  assert.equal(rasterMime(png), 'image/png'); view.setUint32(16, 100000); assert.equal(rasterMime(png), null);
  assert.equal(rasterMime(new Uint8Array([255, 216, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), null);
  assert.equal(rasterMime(strToU8('<svg onload="run()"/>')), null);
});
test('CSV and TSV preserve multiline fields, BOM, formula strings and empty cells', () => {
  const parsed = parseTable('\ufeffname,note,value\r\n合成,"a\nb",=1+1\r\nempty,,', 'example.csv');
  assert.deepEqual(parsed.sheets[0].rows, [['name', 'note', 'value'], ['合成', 'a\nb', '=1+1'], ['empty', '', '']]);
  assert.deepEqual(parseTable('a\tb\n1\t"two\tfields"', 'x.tsv').sheets[0].rows, [['a', 'b'], ['1', 'two\tfields']]);
  assert.throws(() => parseTable('a,"never closes', 'x.csv'), /引号/);
});
test('text preview converts BOM encodings for display without modifying original bytes', () => {
  const utf16 = Buffer.concat([Buffer.from([255, 254]), Buffer.from('合成文本', 'utf16le')]), original = Buffer.from(utf16);
  assert.equal(decodePreviewText(utf16), '合成文本'); assert.deepEqual(utf16, original);
  assert.throws(() => decodePreviewText(new Uint8Array([0, 255])), /encoded|encoding|文件/i);
  assert.throws(() => decodePreviewText(new Uint8Array(1024 * 1024 + 1)), /1 MiB/);
});

test('workbook preflight rejects DTDs and external relations before the Excel parser sees the archive', () => {
  const entries = xml => [['xl/worksheets/sheet1.xml', strToU8(xml)]];
  validatePackageXml(entries('<worksheet/>'), { rejectExternal: true });
  assert.throws(() => validatePackageXml(entries('<!ENTITY x SYSTEM="file:///secret"><worksheet/>')), /实体/);
  assert.throws(() => validatePackageXml([['xl/_rels/workbook.xml.rels', strToU8('<Relationships><Relationship TargetMode="External" Target="https://example.invalid"/></Relationships>')]], { rejectExternal: true }), /外部/);
});
