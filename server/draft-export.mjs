import PDFDocument from 'pdfkit';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findKoreanFont } from './manual-pdf.mjs';
import { zip } from './zip.mjs';

// 업무기안을 PDF·Word(.docx)·한글(.hwpx) 문서로 만든다. 세 형식 모두 같은 구성:
// 큰 제목 '업무 기안서' → 표(제목·기안일·기안자) → 내용 → 첨부파일 목록 → 참고 링크 → 출력 정보.
const xml = value => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const lines = text => String(text ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
const fileSize = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(0.1, n / 1024).toFixed(1) + ' KB';
const sections = d => [
  ['내용', lines(d.content || '')],
  ...(d.files?.length ? [['첨부파일', d.files.map(f => `· ${f.name} (${fileSize(f.size)})`)]] : []),
];
const facts = d => [...(d.doc_no ? [['문서번호', d.doc_no]] : []), ['제목', d.title], ['기안일', d.draft_date], ['기안자', d.drafter || '—']];
const footer = d => `DYKIM PORTAL 업무기안 · 출력일 ${d.printed_on}`;
export const exportFormats = { pdf: { ext: 'pdf', type: 'application/pdf', label: 'PDF' }, docx: { ext: 'docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', label: 'Word' }, hwpx: { ext: 'hwpx', type: 'application/hwp+zip', label: '한글' } };

// ---- PDF ----
export function draftPdf(d) {
  const font = findKoreanFont();
  if (!font) throw Object.assign(new Error('한글 글꼴을 찾지 못해 PDF를 만들 수 없습니다. PDF_FONT 환경 변수로 글꼴 경로를 지정해 주세요.'), { status: 503, expose: true });
  const doc = new PDFDocument({ size: 'A4', margins: { top: 60, bottom: 60, left: 60, right: 60 }, bufferPages: true, info: { Title: d.title, Author: d.drafter || 'DYKIM PORTAL', Subject: '업무 기안서' } });
  doc.registerFont('regular', ...font.regular); doc.registerFont('bold', ...font.bold);
  const left = doc.page.margins.left, width = doc.page.width - left - doc.page.margins.right, bottom = () => doc.page.height - doc.page.margins.bottom;
  const chunks = []; doc.on('data', chunk => chunks.push(chunk));
  const done = new Promise(resolve => doc.on('end', () => resolve(Buffer.concat(chunks))));
  doc.font('bold').fontSize(20).fillColor('#111').text('업무 기안서', left, doc.y, { width, align: 'center' });
  doc.moveDown(1.2);
  const labelWidth = 90;
  for (const [label, value] of facts(d)) {
    doc.font('regular').fontSize(10.5);
    const height = Math.max(26, doc.heightOfString(value || ' ', { width: width - labelWidth - 16 }) + 14);
    if (doc.y + height > bottom()) doc.addPage();
    const y = doc.y;
    doc.rect(left, y, labelWidth, height).fill('#e7f0ea');
    doc.lineWidth(0.7).strokeColor('#9aa9a3').rect(left, y, labelWidth, height).stroke().rect(left + labelWidth, y, width - labelWidth, height).stroke();
    doc.fillColor('#111').font('bold').text(label, left, y + (height - 12) / 2, { width: labelWidth, align: 'center' });
    doc.font('regular').text(value || ' ', left + labelWidth + 8, y + 7, { width: width - labelWidth - 16 });
    doc.y = y + height;
  }
  const heading = text => { doc.moveDown(1.2); if (doc.y + 40 > bottom()) doc.addPage(); doc.x = left; doc.font('bold').fontSize(12.5).fillColor('#17654f').text(text, left, doc.y, { width }); doc.moveTo(left, doc.y + 2).lineTo(left + width, doc.y + 2).lineWidth(0.6).strokeColor('#b9cfc5').stroke(); doc.moveDown(0.5); doc.fillColor('#111'); };
  for (const [title, rows] of sections(d)) {
    heading(title);
    doc.font('regular').fontSize(10.5);
    for (const row of rows) doc.text(row.length ? row : ' ', left, doc.y, { width, lineGap: 3 });
  }
  if (d.links?.length) {
    heading('참고 링크');
    for (const link of d.links) {
      doc.font('regular').fontSize(10.5).fillColor('#111').text(`· ${link.name}  `, left, doc.y, { width, continued: true, lineGap: 3 });
      doc.fillColor('#1a56b0').text(link.url, { link: link.url, underline: true, lineGap: 3 });
    }
    doc.fillColor('#111');
  }
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // 아래 여백 안에 쪽 번호를 쓴다. 여백을 잠시 0으로 두지 않으면 pdfkit이 새 쪽을 만든다.
    const margin = doc.page.margins.bottom; doc.page.margins.bottom = 0;
    doc.font('regular').fontSize(8).fillColor('#777').text(`${footer(d)} · ${i + 1}/${range.count}`, left, doc.page.height - 40, { width, align: 'center', lineBreak: false });
    doc.page.margins.bottom = margin;
  }
  doc.end();
  return done;
}

// ---- Word (.docx) ----
export function draftDocx(d) {
  const font = '맑은 고딕', links = [];
  const run = (text, { bold = false, size, color, underline = false } = {}) => `<w:r><w:rPr>${bold ? '<w:b/>' : ''}${color ? `<w:color w:val="${color}"/>` : ''}${size ? `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>` : ''}${underline ? '<w:u w:val="single"/>' : ''}</w:rPr><w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;
  const para = (content, { align, before = 0, after = 60, keep = false, rule = false } = {}) => `<w:p><w:pPr>${keep ? '<w:keepNext/>' : ''}${rule ? '<w:pBdr><w:bottom w:val="single" w:sz="4" w:space="2" w:color="B9CFC5"/></w:pBdr>' : ''}<w:spacing w:before="${before}" w:after="${after}" w:line="300" w:lineRule="auto"/>${align ? `<w:jc w:val="${align}"/>` : ''}</w:pPr>${content}</w:p>`;
  const border = '<w:top w:val="single" w:sz="6" w:color="9AA9A3"/><w:left w:val="single" w:sz="6" w:color="9AA9A3"/><w:bottom w:val="single" w:sz="6" w:color="9AA9A3"/><w:right w:val="single" w:sz="6" w:color="9AA9A3"/><w:insideH w:val="single" w:sz="6" w:color="9AA9A3"/><w:insideV w:val="single" w:sz="6" w:color="9AA9A3"/>';
  const cell = (text, w, label) => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${label ? '<w:shd w:val="clear" w:color="auto" w:fill="E7F0EA"/>' : ''}<w:vAlign w:val="center"/></w:tcPr>${para(run(text, { bold: label }), { align: label ? 'center' : undefined, after: 0 })}</w:tc>`;
  const table = `<w:tbl><w:tblPr><w:tblW w:w="9638" w:type="dxa"/><w:tblBorders>${border}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="80" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid><w:gridCol w:w="1700"/><w:gridCol w:w="7938"/></w:tblGrid>${facts(d).map(([label, value]) => `<w:tr><w:trPr><w:trHeight w:val="420"/></w:trPr>${cell(label, 1700, true)}${cell(value || '', 7938, false)}</w:tr>`).join('')}</w:tbl>`;
  const heading = text => para(run(text, { bold: true, size: 25, color: '17654F' }), { before: 320, after: 80, keep: true, rule: true });
  let body = para(run('업무 기안서', { bold: true, size: 40 }), { align: 'center', after: 280 }) + table;
  for (const [title, rows] of sections(d)) body += heading(title) + rows.map(row => para(run(row))).join('');
  if (d.links?.length) {
    body += heading('참고 링크');
    for (const link of d.links) { const id = `rIdLink${links.length + 1}`; links.push({ id, url: link.url }); body += para(run(`· ${link.name}  `) + `<w:hyperlink r:id="${id}" w:history="1">${run(link.url, { color: '1A56B0', underline: true })}</w:hyperlink>`); }
  }
  body += para(run(footer(d), { size: 16, color: '777777' }), { align: 'center', before: 480, after: 0 });
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${font}" w:eastAsia="${font}" w:hAnsi="${font}" w:cs="${font}"/><w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="en-US" w:eastAsia="ko-KR"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="60"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${links.map(link => `<Relationship Id="${link.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xml(link.url)}" TargetMode="External"/>`).join('')}</Relationships>`;
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(d.title)}</dc:title><dc:subject>업무 기안서</dc:subject><dc:creator>${xml(d.drafter)}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</dcterms:created></cp:coreProperties>`;
  return zip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>' },
    { name: 'word/document.xml', data: document },
    { name: 'word/styles.xml', data: styles },
    { name: 'word/_rels/document.xml.rels', data: rels },
    { name: 'docProps/core.xml', data: core },
  ]);
}

// ---- 한글 (.hwpx) ----
// 서식(header.xml)은 회의록형 OWPML 템플릿을 쓴다: charPr 7=18pt 굵게(제목), 8=12pt 굵게(구역 제목), 9=10pt 굵게(표 머리), 0=10pt 본문,
// paraPr 20=가운데, 21=가운데(표 칸), 22=양쪽(표 칸), borderFill 3=실선, 4=실선+연녹색 배경.
const templateDir = fileURLToPath(new URL('./doc-templates/hwpx/', import.meta.url));
let hwpxTemplate = null;
const template = () => hwpxTemplate ??= Object.fromEntries(['mimetype', 'version.xml', 'Contents/header.xml', 'Contents/content.hpf', 'settings.xml', 'Preview/PrvImage.png', 'Preview/PrvText.txt', 'META-INF/container.xml', 'META-INF/manifest.xml', 'META-INF/container.rdf'].map(name => [name, readFileSync(templateDir + name)]));
const NS = 'xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hhs="http://www.hancom.co.kr/hwpml/2011/history" xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf/" xmlns:ooxmlchart="http://www.hancom.co.kr/hwpml/2016/ooxmlchart" xmlns:hwpunitchar="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar" xmlns:epub="http://www.idpf.org/2007/ops" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"';
const SEC_PR = '<hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" tabStopVal="4000" tabStopUnit="HWPUNIT" outlineShapeIDRef="1" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0"><hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/><hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/><hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" hideFirstPageNum="0" hideFirstEmptyLine="0" showLineNumber="0"/><hp:lineNumberShape restartType="0" countBy="0" distance="0" startNumber="0"/><hp:pagePr landscape="WIDELY" width="59528" height="84186" gutterType="LEFT_ONLY"><hp:margin header="4252" footer="4252" gutter="0" left="8504" right="8504" top="5668" bottom="4252"/></hp:pagePr><hp:footNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="283" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="EACH_COLUMN" beneathText="0"/></hp:footNotePr><hp:endNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="14692344" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="0" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="END_OF_DOCUMENT" beneathText="0"/></hp:endNotePr><hp:pageBorderFill type="BOTH" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill><hp:pageBorderFill type="EVEN" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill><hp:pageBorderFill type="ODD" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill></hp:secPr>';
export function draftHwpx(d) {
  let next = 1000000001;
  const id = () => String(next++);
  const t = text => text ? `<hp:t>${xml(text)}</hp:t>` : '<hp:t/>';
  const p = (text, { para = 0, char = 0 } = {}) => `<hp:p id="${id()}" paraPrIDRef="${para}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="${char}">${t(text)}</hp:run></hp:p>`;
  const cell = (text, col, row, width, label) => `<hp:tc name="" header="0" hasMargin="1" protect="0" editable="0" dirty="1" borderFillIDRef="${label ? 4 : 3}"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${p(text, { para: label ? 21 : 22, char: label ? 9 : 0 })}</hp:subList><hp:cellAddr colAddr="${col}" rowAddr="${row}"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="${width}" height="2400"/><hp:cellMargin left="283" right="283" top="141" bottom="141"/></hp:tc>`;
  const rows = facts(d);
  const tableId = '1000099001';
  const table = `<hp:p id="${id()}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:tbl id="${tableId}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="0" rowCnt="${rows.length}" colCnt="2" cellSpacing="0" borderFillIDRef="3" noAdjust="0"><hp:sz width="42520" widthRelTo="ABSOLUTE" height="${2400 * rows.length}" heightRelTo="ABSOLUTE" protect="0"/><hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/><hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:inMargin left="0" right="0" top="0" bottom="0"/>${rows.map(([label, value], row) => `<hp:tr>${cell(label, 0, row, 8504, true)}${cell(value || ' ', 1, row, 34016, false)}</hp:tr>`).join('')}</hp:tbl></hp:run><hp:run charPrIDRef="0"><hp:t/></hp:run></hp:p>`;
  let body = `<hp:p id="${id()}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0">${SEC_PR}<hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl></hp:run><hp:run charPrIDRef="0"><hp:t/></hp:run></hp:p>`;
  body += p('업무 기안서', { para: 20, char: 7 }) + p('') + table;
  for (const [title, items] of sections(d)) body += p('') + p(title, { char: 8 }) + items.map(line => p(line)).join('');
  if (d.links?.length) body += p('') + p('참고 링크', { char: 8 }) + d.links.map(link => p(`· ${link.name}  ${link.url}`)).join('');
  body += p('') + p(footer(d), { para: 20, char: 0 });
  const files = template();
  const hpf = files['Contents/content.hpf'].toString('utf8').replace('<opf:title/>', `<opf:title>${xml(d.title)}</opf:title>`).replace('<opf:meta name="creator" content="text"/>', `<opf:meta name="creator" content="text">${xml(d.drafter)}</opf:meta>`);
  return zip([
    { name: 'mimetype', data: files.mimetype, store: true },
    { name: 'version.xml', data: files['version.xml'] },
    { name: 'Contents/header.xml', data: files['Contents/header.xml'] },
    { name: 'Contents/section0.xml', data: `<?xml version='1.0' encoding='UTF-8'?><hs:sec ${NS}>${body}</hs:sec>` },
    { name: 'Contents/content.hpf', data: hpf },
    { name: 'settings.xml', data: files['settings.xml'] },
    { name: 'Preview/PrvImage.png', data: files['Preview/PrvImage.png'], store: true },
    { name: 'Preview/PrvText.txt', data: files['Preview/PrvText.txt'] },
    { name: 'META-INF/container.xml', data: files['META-INF/container.xml'] },
    { name: 'META-INF/manifest.xml', data: files['META-INF/manifest.xml'] },
    { name: 'META-INF/container.rdf', data: files['META-INF/container.rdf'] },
  ]);
}
