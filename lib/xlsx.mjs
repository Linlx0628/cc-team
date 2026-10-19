// lib/xlsx.mjs —— 零依赖 XLSX(xlsx/Office Open XML SpreadsheetML)生成器。
//
// 项目只有 better-sqlite3 一个依赖,为导出报告引入 exceljs/xlsx 之类不值得:
// .xlsx 本质是一个 ZIP 包(内含一组 XML),Node 自带 zlib 就能 deflate,
// ZIP 的 local file header / central directory / EOCD 结构手写约百行。
// 这里只实现「写」:inlineStr 文本 + 数字 + 少量样式(表头加粗填充/千分位),
// 覆盖 token-monitor 报告导出的全部需求;不解析、不读 xlsx。
//
// 兼容性:输出的包被 Excel / WPS / Numbers / LibreOffice 打开验证过
// (tests/plan-export.test.mjs 有 ZIP 结构 + CRC + XML 形状的自校验)。

import zlib from "node:zlib";

// ── CRC32(ZIP 需要;查表法,poly 0xEDB88320) ──────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ── 最小 ZIP writer(全部条目 deflate;大小已知,不需要 data descriptor) ─────────
// dosTime/dosDate: ZIP 条目的固定时间戳(DOS 格式),传入同一时刻保证包内一致。
// DOS date = (年-1980)<<9 | 月<<5 | 日;DOS time = 时<<11 | 分<<5 | 秒/2。
function dosDateTime(date) {
  const y = Math.max(1980, date.getFullYear());
  const dosDate = ((y - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  return { dosTime, dosDate };
}

function zip(entries, when) {
  const { dosTime, dosDate } = dosDateTime(when);
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // method: deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra len
    chunks.push(local, nameBuf, deflated);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // central dir signature
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(dosTime, 12);
    cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(deflated.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));

    offset += local.length + nameBuf.length + deflated.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

// ── XML 基础 ────────────────────────────────────────────────────────────────
function escXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // 控制字符(XML 1.0 非法)替换掉,避免脏字符串打死整个文件
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

// Excel 列名:1→A, 26→Z, 27→AA …
export function xlColName(n) {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// ── 样式集(styles.xml 固定 5 个 xf,与下面 buildSheet 的 s= 索引一一对应) ──────
// 0 默认 / 1 加粗 / 2 千分位整数 / 3 表头(加粗+灰底) / 4 千分位整数加粗(合计行)
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEDF2EF"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="3" fontId="1" fillId="2" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

// 单元格值 → <c> 片段。值类型:number(含 finite 校验)/字符串/其余按空单元格。
// style: 0 默认 1 加粗 2 千分位 3 表头 4 千分位加粗
function cellXml(ref, value, style) {
  const s = style ? ` s="${style}"` : "";
  if (typeof value === "number" && Number.isFinite(value)) {
    return `<c r="${ref}"${s}><v>${value}</v></c>`;
  }
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && typeof value.v === "number" && Number.isFinite(value.v)) {
    return `<c r="${ref}"${s}><v>${value.v}</v></c>`;
  }
  const text = typeof value === "object" ? String(value.v ?? "") : String(value);
  if (text === "") return "";
  return `<c r="${ref}" t="inlineStr"${s}><is><t xml:space="preserve">${escXml(text)}</t></is></c>`;
}

// rows: 数组的数组;每项为 string|number|null|{v, style}。
// cols(可选): 每列宽度(字符数);省略时按内容估宽,封顶 42。
// freezeHeader: 冻结首行(默认 true —— 报告表头在长表里滚走很难受)。
function buildSheetXml(rows, cols, freezeHeader) {
  const widthOf = (cell) => {
    const raw = typeof cell === "object" && cell !== null ? cell.v : cell;
    const s = typeof raw === "number" ? String(Math.round(raw)).length + 2 : String(raw ?? "").length;
    // CJK 字符按 2 个单位估宽
    const cjk = (String(raw ?? "").match(/[\u2e80-\u9fff\uf900-\ufaff]/g) || []).length;
    return Math.min(42, Math.max(6, s + cjk + 2));
  };
  const colCount = Math.max(1, ...rows.map((r) => r.length));
  const widths = [];
  for (let c = 0; c < colCount; c++) {
    if (cols && cols[c] != null) widths.push(Math.min(60, Math.max(6, cols[c])));
    else {
      let w = 8;
      for (const row of rows) if (row[c] !== undefined) w = Math.max(w, widthOf(row[c]));
      widths.push(w);
    }
  }
  const colXml = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("");
  const pane = freezeHeader
    ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    : `<sheetViews><sheetView workbookViewId="0"/></sheetViews>`;
  const body = rows
    .map((row, ri) => {
      const cells = row
        .map((cell, ci) => cellXml(`${xlColName(ci + 1)}${ri + 1}`, typeof cell === "object" && cell !== null ? cell.v : cell, typeof cell === "object" && cell !== null && cell.style != null ? cell.style : 0))
        .join("");
      return `<row r="${ri + 1}">${cells}</row>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${pane}<sheetFormatPr defaultRowHeight="15"/><cols>${colXml}</cols><sheetData>${body}</sheetData></worksheet>`;
}

// ── 工作簿组装 ───────────────────────────────────────────────────────────────
// sheets: [{ name, rows, cols? }];首个 sheet 冻结首行(报告表头),其余同。
// 名称非法字符(: \ / ? * [ ])会被替换为空格,重复名自动加后缀。
export function buildXlsx(sheets, { when = new Date() } = {}) {
  const used = new Set();
  const safeNames = sheets.map((s) => {
    let name = String(s.name || "Sheet").replace(/[:\\/?*[\]]/g, " ").slice(0, 31) || "Sheet";
    let candidate = name;
    let i = 2;
    while (used.has(candidate)) candidate = (name.slice(0, 28) + "_" + i++).slice(0, 31);
    used.add(candidate);
    return candidate;
  });

  const entries = [
    {
      name: "[Content_Types].xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
        "utf8",
      ),
    },
    {
      name: "_rels/.rels",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
        "utf8",
      ),
    },
    {
      name: "xl/workbook.xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView xWindow="0" yWindow="0" windowWidth="20000" windowHeight="12000"/></bookViews><sheets>${safeNames.map((n, i) => `<sheet name="${escXml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
        "utf8",
      ),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
        "utf8",
      ),
    },
    { name: "xl/styles.xml", data: Buffer.from(STYLES_XML, "utf8") },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: Buffer.from(buildSheetXml(s.rows, s.cols, s.freezeHeader !== false), "utf8") })),
  ];

  return zip(entries, when);
}

// 便捷封装:千分位数字单元格
export function num(v) {
  return { v: Number(v) || 0, style: 2 };
}
// 千分位加粗(合计行)
export function numBold(v) {
  return { v: Number(v) || 0, style: 4 };
}
// 加粗文本(合计行/分组行)
export function bold(s) {
  return { v: s == null ? "" : s, style: 1 };
}
