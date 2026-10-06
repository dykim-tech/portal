import PDFDocument from 'pdfkit';
import { existsSync } from 'node:fs';

// 운영자 매뉴얼(Markdown)을 PDF로 변환한다. 한글 표시를 위해 PC에 설치된 한글 글꼴을 사용한다.
const fontCandidates = [
  () => process.env.PDF_FONT ? { regular: [process.env.PDF_FONT], bold: [process.env.PDF_FONT_BOLD || process.env.PDF_FONT] } : null,
  () => ({ regular: ['C:\\Windows\\Fonts\\malgun.ttf'], bold: ['C:\\Windows\\Fonts\\malgunbd.ttf'] }),
  () => ({ regular: ['/usr/share/fonts/truetype/nanum/NanumGothic.ttf'], bold: ['/usr/share/fonts/truetype/nanum/NanumGothicBold.ttf'] }),
  () => ({ regular: ['/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', 'NotoSansCJKkr-Regular'], bold: ['/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc', 'NotoSansCJKkr-Bold'] }),
  () => ({ regular: ['/System/Library/Fonts/AppleSDGothicNeo.ttc', 'AppleSDGothicNeo-Regular'], bold: ['/System/Library/Fonts/AppleSDGothicNeo.ttc', 'AppleSDGothicNeo-Bold'] }),
];

export function findKoreanFont() {
  for (const candidate of fontCandidates) {
    const font = candidate();
    if (font && existsSync(font.regular[0])) return { regular: font.regular, bold: existsSync(font.bold[0]) ? font.bold : font.regular };
  }
  return null;
}

const COLORS = { ink: '#172b29', muted: '#5f6f6b', green: '#17654f', line: '#cfdcd6', soft: '#eef5f1', head: '#dcefe3' };

function segments(text) {
  const clean = text.replace(/\[([^\]]+)\]\([^)\s]+\)/g, '$1');
  const parts = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0, match;
  while ((match = pattern.exec(clean))) {
    if (match.index > last) parts.push({ text: clean.slice(last, match.index) });
    const token = match[0];
    parts.push(token.startsWith('**') ? { text: token.slice(2, -2), bold: true } : { text: token.slice(1, -1), code: true });
    last = match.index + token.length;
  }
  if (last < clean.length) parts.push({ text: clean.slice(last) });
  return parts.length ? parts : [{ text: '' }];
}

const plain = text => segments(text).map(part => part.text).join('');

export function renderManualPdf(markdown, { title = 'DYKIM PORTAL 운영자 매뉴얼' } = {}) {
  const font = findKoreanFont();
  if (!font) throw Object.assign(new Error('한글 글꼴을 찾지 못해 PDF를 만들 수 없습니다. PDF_FONT 환경 변수로 글꼴 경로를 지정해 주세요.'), { status: 503, expose: true });
  const doc = new PDFDocument({ size: 'A4', margins: { top: 56, bottom: 60, left: 54, right: 54 }, bufferPages: true, info: { Title: title, Author: 'DYKIM PORTAL' } });
  doc.registerFont('regular', ...font.regular);
  doc.registerFont('bold', ...font.bold);
  const left = doc.page.margins.left, width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom;
  const ensure = height => { if (doc.y + height > bottom()) doc.addPage(); };

  const richText = (text, { size = 10, color = COLORS.ink, x = left, w = width, bold = false, lineGap = 3 } = {}) => {
    const parts = segments(text);
    doc.fontSize(size);
    const height = doc.font(bold ? 'bold' : 'regular').heightOfString(plain(text) || ' ', { width: w, lineGap });
    ensure(Math.min(height, bottom() - doc.page.margins.top));
    const startY = doc.y;
    parts.forEach((part, index) => {
      doc.font(part.bold || bold ? 'bold' : 'regular').fillColor(part.code ? COLORS.green : color);
      const options = { width: w, lineGap, continued: index < parts.length - 1 };
      if (index === 0) doc.text(part.text, x, startY, options); else doc.text(part.text, options);
    });
    doc.fillColor(COLORS.ink);
  };

  const table = rows => {
    const columns = Math.max(...rows.map(row => row.length));
    doc.fontSize(9);
    const natural = Array.from({ length: columns }, (_, column) => Math.max(...rows.map((row, index) => doc.font(index === 0 ? 'bold' : 'regular').widthOfString(plain(row[column] ?? ''))), 20) + 12);
    const minimum = 56, total = natural.reduce((sum, value) => sum + value, 0);
    let widths = total <= width ? natural.map(value => value * width / total) : natural.map(value => Math.max(minimum, value * width / total));
    const scale = width / widths.reduce((sum, value) => sum + value, 0);
    widths = widths.map(value => value * scale);
    const rowHeight = (row, header) => Math.max(...widths.map((w, column) => doc.font(header ? 'bold' : 'regular').fontSize(9).heightOfString(plain(row[column] ?? '') || ' ', { width: w - 10, lineGap: 2 }))) + 10;
    const drawRow = (row, header) => {
      const height = rowHeight(row, header);
      if (doc.y + height > bottom()) { doc.addPage(); if (!header) drawRow(rows[0], true); }
      const y = doc.y;
      let x = left;
      widths.forEach((w, column) => {
        if (header) doc.rect(x, y, w, height).fill(COLORS.head);
        doc.lineWidth(0.6).strokeColor(COLORS.line).rect(x, y, w, height).stroke();
        doc.font(header ? 'bold' : 'regular').fontSize(9).fillColor(COLORS.ink).text(plain(row[column] ?? ''), x + 5, y + 5, { width: w - 10, lineGap: 2 });
        x += w;
      });
      doc.x = left; doc.y = y + height;
    };
    rows.forEach((row, index) => drawRow(row, index === 0));
    doc.moveDown(0.8);
  };

  const lines = markdown.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^\s*```/.test(line)) {
      const code = [];
      while (++index < lines.length && !/^\s*```/.test(lines[index])) code.push(lines[index]);
      const text = code.join('\n');
      doc.font('regular').fontSize(8.5);
      const height = doc.heightOfString(text || ' ', { width: width - 20, lineGap: 2 }) + 16;
      ensure(Math.min(height, bottom() - doc.page.margins.top));
      const y = doc.y;
      doc.roundedRect(left, y, width, height, 4).fillAndStroke(COLORS.soft, COLORS.line);
      doc.fillColor(COLORS.ink).text(text, left + 10, y + 8, { width: width - 20, lineGap: 2 });
      doc.x = left; doc.y = y + height; doc.moveDown(0.6);
      continue;
    }
    if (line.startsWith('|') && lines[index + 1]?.startsWith('|') && /^\|[\s:|-]+\|$/.test(lines[index + 1])) {
      const cells = row => row.split('|').slice(1, -1).map(cell => cell.trim());
      const rows = [cells(line)];
      index += 2;
      while (index < lines.length && lines[index].startsWith('|')) rows.push(cells(lines[index++]));
      index--;
      table(rows);
      continue;
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1].length, text = plain(heading[2]);
      if (level === 1) {
        doc.font('bold').fontSize(20).fillColor(COLORS.green).text(text, left, doc.y, { width });
        doc.moveDown(0.3);
        doc.lineWidth(1.5).strokeColor(COLORS.green).moveTo(left, doc.y).lineTo(left + width, doc.y).stroke();
        doc.moveDown(0.8);
      } else if (level === 2) {
        ensure(60);
        doc.moveDown(0.6);
        doc.font('bold').fontSize(14).fillColor(COLORS.green).text(text, left, doc.y, { width });
        doc.moveDown(0.2);
        doc.lineWidth(0.6).strokeColor(COLORS.line).moveTo(left, doc.y).lineTo(left + width, doc.y).stroke();
        doc.moveDown(0.5);
      } else {
        ensure(40);
        doc.moveDown(0.4);
        doc.font('bold').fontSize(level === 3 ? 11.5 : 10.5).fillColor(COLORS.ink).text(text, left, doc.y, { width });
        doc.moveDown(0.3);
      }
      doc.fillColor(COLORS.ink);
      continue;
    }
    const bullet = /^(\s*)([-*]|\d+\.)\s+(.+)$/.exec(line);
    if (bullet) {
      const depth = Math.min(3, Math.floor(bullet[1].length / 2)), indent = 12 + depth * 14;
      const marker = /\d+\./.test(bullet[2]) ? bullet[2] : '•';
      doc.font('regular').fontSize(10);
      const height = doc.heightOfString(plain(bullet[3]) || ' ', { width: width - indent - 12, lineGap: 3 });
      ensure(Math.min(height, 200));
      const y = doc.y;
      doc.fillColor(COLORS.green).font('bold').text(marker, left + indent - 12, y, { width: 18 });
      doc.y = y;
      richText(bullet[3], { x: left + indent + (marker.length > 1 ? 4 : 0), w: width - indent - 12 });
      doc.moveDown(0.2);
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      doc.font('regular').fontSize(9.5);
      const height = doc.heightOfString(plain(quote[1]) || ' ', { width: width - 24, lineGap: 3 }) + 12;
      ensure(height);
      const y = doc.y;
      doc.rect(left, y, width, height).fill(COLORS.soft);
      doc.rect(left, y, 3, height).fill(COLORS.green);
      doc.y = y + 6;
      richText(quote[1], { size: 9.5, color: COLORS.muted, x: left + 14, w: width - 24 });
      doc.x = left; doc.y = y + height; doc.moveDown(0.6);
      continue;
    }
    if (!line.trim()) { doc.moveDown(0.35); continue; }
    richText(line);
    doc.moveDown(0.25);
  }

  const range = doc.bufferedPageRange();
  for (let page = range.start; page < range.start + range.count; page++) {
    doc.switchToPage(page);
    const margin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('regular').fontSize(8).fillColor(COLORS.muted).text(`${title} · ${page + 1} / ${range.count}`, left, doc.page.height - 36, { width, align: 'center', lineBreak: false });
    doc.page.margins.bottom = margin;
  }
  doc.end();
  return doc;
}

export function manualPdfBuffer(markdown, options) {
  return new Promise((resolve, reject) => {
    const doc = renderManualPdf(markdown, options), chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}
