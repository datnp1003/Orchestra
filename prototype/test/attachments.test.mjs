import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, crc32 } from 'node:zlib';
import { extractText, readZip, safeEntryPath, attachmentBlocks, isAttachmentText, attachmentName, sliceText, decodeText, MAX_INLINE_CHARS, READ_PAGE } from '../dist/attachments.js';

/** minimal zip writer (deflate) — fixtures are built here, no binary files in the repo */
export function zip(files, { store = false } = {}) {
  const locals = [], centrals = [];
  let off = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content), comp = store ? data : deflateRawSync(data), n = Buffer.from(name);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x800, 6); h.writeUInt16LE(store ? 0 : 8, 8);
    h.writeUInt32LE(crc32(data), 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(n.length, 26);
    locals.push(h, n, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x800, 8); c.writeUInt16LE(store ? 0 : 8, 10);
    c.writeUInt32LE(crc32(data), 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42);
    centrals.push(c, n);
    off += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(centrals), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(Object.keys(files).length, 8); e.writeUInt16LE(Object.keys(files).length, 10);
  e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, e]);
}

test('docx: paragraphs, tabs, breaks, table rows as "a | b", entities; deleted/field text not in <w:t> ignored', () => {
  const doc = '<w:document><w:body>'
    + '<w:p><w:r><w:t>Báo cáo</w:t></w:r><w:r><w:t xml:space="preserve"> kiểm thử &amp; &lt;API&gt; &#x1F600;</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t>A</w:t><w:tab/><w:t>B</w:t><w:br/><w:t>C</w:t></w:r></w:p>'
    + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Mức</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Số</w:t></w:r></w:p><w:p><w:r><w:t>lỗi</w:t></w:r></w:p></w:tc></w:tr>'
    + '<w:tr><w:tc><w:p><w:r><w:t>High</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>5</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
    + '<w:p><w:r><w:delText>gone</w:delText><w:instrText>PAGE</w:instrText><w:t>end</w:t></w:r></w:p></w:body></w:document>';
  const r = extractText('r.docx', zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': doc }));
  assert.equal(r.kind, 'docx');
  assert.equal(r.text, 'Báo cáo kiểm thử & <API> 😀\nA\tB\nC\nMức | Số lỗi\nHigh | 5\nend');
  assert.throws(() => extractText('x.docx', zip({ 'a.txt': 'x' })), /not a Word document/);
});

test('xlsx: every sheet as CSV — shared/inline strings, numbers, booleans, gaps by cell ref, CSV quoting, rels path', () => {
  const z = zip({
    'xl/workbook.xml': '<workbook><sheets><sheet name="Tổng &amp; hợp" sheetId="1" r:id="rId1"/><sheet name="S2" sheetId="2" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="x" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst><si><t>Tên</t></si><si><r><t>Giá</t></r><r><t>, VND</t></r></si><si><t>say "hi"</t></si></sst>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData>'
      + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>'
      + '<row r="2"><c r="A2" t="inlineStr"><is><t>Áo</t></is></c><c r="B2" t="b"><v>1</v></c><c r="C2"><f>1+1</f><v>2</v></c></row>'
      + '<row r="3"><c r="A3" t="s"><v>2</v></c></row><row r="4"/></sheetData></worksheet>',
    'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row r="1"><c r="AA1"><v>7</v></c></row></sheetData></worksheet>',
  });
  const r = extractText('b.xlsx', z);
  assert.equal(r.kind, 'xlsx');
  assert.equal(r.text, `## Sheet: Tổng & hợp\nTên,,"Giá, VND"\nÁo,TRUE,2\n"say ""hi"""\n\n## Sheet: S2\n${','.repeat(26)}7`);
});

test('pptx: slides in number order (10 after 9), paragraphs as lines', () => {
  const s = (t) => `<p:sld><a:p><a:r><a:t>${t}</a:t></a:r></a:p><a:p><a:r><a:t>more</a:t></a:r></a:p></p:sld>`;
  const r = extractText('d.pptx', zip({ 'ppt/presentation.xml': '<p/>', 'ppt/slides/slide10.xml': s('ten'), 'ppt/slides/slide9.xml': s('nine') }));
  assert.equal(r.text, '## Slide 9\nnine\nmore\n\n## Slide 10\nten\nmore');
});

test('text / binary / pdf / zip kinds; UTF-8 with BOM; invalid UTF-8 or NUL → binary', () => {
  assert.deepEqual(extractText('a.md', Buffer.from('\uFEFF# Tiêu đề')), { kind: 'text', text: '# Tiêu đề' });
  assert.equal(extractText('data.bin', Buffer.from([0x41, 0, 0x42])).kind, 'binary');
  assert.equal(extractText('x.csv', Buffer.from([0xc3, 0x28])).kind, 'binary');
  assert.equal(decodeText(Buffer.alloc(0)), '');
  assert.deepEqual(extractText('a.PDF', Buffer.from('%PDF-1.7')), { kind: 'pdf', text: null });
  assert.deepEqual(extractText('a.zip', zip({ 'x': 'y' })), { kind: 'zip', text: null });
});

test('readZip: stored + deflate entries, dirs skipped; caps on count / total size; corrupt / non-zip / lying header refused', () => {
  const z = zip({ 'src/': '', 'src/a.ts': 'export {}', 'b.txt': 'hello' });
  const e = readZip(z);
  assert.deepEqual(e.map((x) => [x.name, x.size, x.read().toString()]), [['src/a.ts', 9, 'export {}'], ['b.txt', 5, 'hello']]);
  assert.equal(readZip(zip({ 'a': 'x' }, { store: true }))[0].read().toString(), 'x');
  assert.throws(() => readZip(z, { entries: 2, bytes: 1e9 }), /too many files/);
  assert.throws(() => readZip(z, { entries: 10, bytes: 10 }), /more than/);
  assert.throws(() => readZip(Buffer.from('not a zip at all, nope, not even close')), /not a zip/);
  // zip bomb: header claims 10 bytes, data inflates to 1 MB → refused (output capped by the declared size)
  const bomb = zip({ 'big.txt': 'a'.repeat(1 << 20) });
  const cdAt = bomb.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bomb.writeUInt32LE(10, cdAt + 24);
  assert.throws(() => readZip(bomb)[0].read());
});

test('safeEntryPath: blocks traversal, absolute, drive, reserved names; normalizes slashes', () => {
  assert.equal(safeEntryPath('a\\b/./c.txt'), 'a/b/c.txt');
  for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:/x', 'c:x', 'a/CON', 'nul.txt', 'a/b.', 'x:y', '', '.', 'a\x01b']) assert.equal(safeEntryPath(bad), null, bad);
});

test('attachment blocks: tagged text (hidden from display), truncation pointer, pdf document block, zip tree, errors', () => {
  const [b] = attachmentBlocks({ id: 'file-1', name: 'spec "v2".md', kind: 'text', size: 2048, text: 'hi' });
  assert.equal(b.text, '<attachment id="file-1" name="spec _v2_.md" type="text" size="2 KB">\nhi\n</attachment>');
  assert.ok(isAttachmentText(b.text));
  assert.equal(attachmentName(b.text), 'spec _v2_.md');
  assert.ok(!isAttachmentText('<attachment id="file-1" name="x"> but the user typed it'));
  const long = attachmentBlocks({ id: 'file-2', name: 'l.txt', kind: 'text', size: 1, text: 'x'.repeat(MAX_INLINE_CHARS + 5) })[0].text;
  assert.match(long, /truncated: 50000 of 50005 chars shown — attachment_read id="file-2" offset=50000/);
  const pdf = attachmentBlocks({ id: 'file-3', name: 'a.pdf', kind: 'pdf', size: 3, pdfBase64: 'QUJD' });
  assert.deepEqual(pdf[0], { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'QUJD' }, title: 'a.pdf' });
  assert.match(pdf[1].text, /document block/);
  assert.match(attachmentBlocks({ id: 'file-4', name: 'big.pdf', kind: 'pdf', size: 3 })[0].text, /too large to read inline/);
  assert.match(attachmentBlocks({ id: 'file-5', name: 'a.zip', kind: 'zip', size: 3, tree: [{ path: 'src/a.ts', size: 9 }], skipped: 1 })[0].text, /Unpacked 1 files \(1 unsafe\/unwritable entries skipped\):\nsrc\/a\.ts \(9 B\)/);
  assert.match(attachmentBlocks({ id: 'file-6', name: 'x.docx', kind: 'docx', size: 3, error: 'corrupt zip' })[0].text, /could not read this docx file: corrupt zip/);
  assert.equal(sliceText('abcdef', 2, 3), 'cde\n…(5 of 6 chars — offset=5 for more)');
  assert.equal(sliceText('abc', 9), '(end of text)');
  assert.ok(READ_PAGE + 100 < 20_000, 'a page + pointer fits the brain tool-result cap');
});
