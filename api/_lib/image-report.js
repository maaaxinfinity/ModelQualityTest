const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const sharp = require('sharp');
const { fetchImageBytes } = require('./providers');

const ROOT = path.join(__dirname, '..', '..');
const TECTONIC_SOURCE = path.join(ROOT, 'vendor', 'tectonic', 'tectonic');
const TECTONIC_CACHE = path.join(ROOT, 'vendor', 'tectonic', 'cache');
const TECTONIC_RUNTIME = path.join(os.tmpdir(), 'mqt-tectonic-0.16.9');
const EDIT_ASSET_DIR = path.join(ROOT, 'assets', 'image-edit');
const MAX_RESULTS = 240;
const MAX_IMAGES_PER_RESULT = 10;
const MAX_REPORT_IMAGE_FILES = 240;
const MAX_PDF_BYTES = 200 * 1024 * 1024;
const REPORT_IMAGE_CONCURRENCY = 6;

const CATEGORY_ORDER = ['回图能力', 'Edit 多图输入', 'Quality × Size 矩阵', 'n 多图与耗时'];
const MATRIX_QUALITIES = ['low', 'medium', 'high'];
const MATRIX_SIZES = [
  '1024x1024', '1536x1024', '1024x1536', '2048x2048',
  '2048x1152', '3840x2160', '2160x3840', 'auto'
];
const EDIT_FIXTURES = [
  ['scene-b.png', 'Image 1 · 场景 B', 'edit target'],
  ['object-fox.png', 'Image 2 · 红狐', 'reference object'],
  ['object-orb.png', 'Image 3 · 蓝玻璃球', 'reference object'],
  ['object-rocket.png', 'Image 4 · 黄火箭', 'reference object'],
  ['object-cactus.png', 'Image 5 · 仙人掌', 'reference object'],
  ['object-robot.png', 'Image 6 · 紫机器人', 'reference object'],
  ['object-compass.png', 'Image 7 · 黄铜罗盘', 'reference object'],
  ['object-mug.png', 'Image 8 · 条纹杯', 'reference object']
];
function clipped(value, max = 240) {
  return String(value == null ? '' : value).slice(0, max);
}

function numeric(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function cleanArray(value, max = 12) {
  return Array.isArray(value) ? value.slice(0, max).map((item) => clipped(item, 80)) : [];
}

function cleanImage(image) {
  if (!image || typeof image !== 'object') return null;
  const src = String(image.src || '').trim();
  const isUrl = /^https:\/\//i.test(src);
  const isData = /^data:image\/(?:png|jpe?g|webp);base64,/i.test(src);
  if (!isUrl && !isData) return null;
  if (isUrl && src.length > 8192) return null;
  if (isData && src.length > 4_000_000) return null;
  return {
    src,
    index: numeric(image.index),
    response_format: clipped(image.response_format, 24),
    width: numeric(image.width),
    height: numeric(image.height),
    mime_type: clipped(image.mime_type, 40),
    byte_size: numeric(image.byte_size)
  };
}

function cleanProbe(probe) {
  const source = probe && typeof probe === 'object' ? probe : {};
  return {
    requested_n: numeric(source.requested_n),
    returned_n: numeric(source.returned_n),
    requested_format: clipped(source.requested_format, 24),
    returned_formats: cleanArray(source.returned_formats, 10),
    quality: clipped(source.quality, 24),
    size: clipped(source.size, 40),
    requested_size: clipped(source.requested_size, 40),
    actual_sizes: cleanArray(source.actual_sizes, MAX_IMAGES_PER_RESULT),
    actual_bytes: Array.isArray(source.actual_bytes)
      ? source.actual_bytes.slice(0, MAX_IMAGES_PER_RESULT).map(numeric)
      : [],
    elapsed_ms: numeric(source.elapsed_ms),
    ms_per_image: numeric(source.ms_per_image),
    dimension_probe_ms: numeric(source.dimension_probe_ms),
    count_ok: source.count_ok === true ? true : source.count_ok === false ? false : null,
    format_ok: source.format_ok === true ? true : source.format_ok === false ? false : null,
    size_ok: source.size_ok === true ? true : source.size_ok === false ? false : null
  };
}

function sanitizeImageReport(report) {
  const source = report && typeof report === 'object' ? report : {};
  const rows = Array.isArray(source.results) ? source.results.slice(0, MAX_RESULTS) : [];
  return {
    generated_at: clipped(source.generated_at || new Date().toISOString(), 64),
    expected_probe_count: Math.max(1, Math.min(100, Number(source.expected_probe_count) || 33)),
    results: rows.map((row) => ({
      question_id: clipped(row.question_id, 120),
      question_name: clipped(row.question_name, 180),
      category: clipped(row.category, 80),
      endpoint_name: clipped(row.endpoint_name, 160),
      model_id: clipped(row.model_id, 180),
      routed_model_id: clipped(row.routed_model_id, 180),
      endpoint_type: clipped(row.endpoint_type, 80),
      edit_input_count: numeric(row.edit_input_count),
      ok: row.ok === true,
      response_status: numeric(row.response_status),
      elapsed_ms: numeric(row.elapsed_ms),
      estimated_cost_usd: numeric(row.estimated_cost_usd),
      error_message: clipped(row.error_message, 1200),
      manual_verdict: row.manual_verdict === 'pass' || row.manual_verdict === 'fail' ? row.manual_verdict : null,
      probe: cleanProbe(row.probe),
      images: (Array.isArray(row.images) ? row.images : [])
        .slice(0, MAX_IMAGES_PER_RESULT)
        .map(cleanImage)
        .filter(Boolean)
    })).filter((row) => row.question_id)
  };
}

function texEscape(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/×/g, 'x')
    .replace(/\$/g, '＄')
    .replace(/([{}%&#_])/g, '\\$1')
    .replace(/\^/g, '\\textasciicircum{}')
    .replace(/~/g, '\\textasciitilde{}');
}

function formatMs(value) {
  const ms = numeric(value);
  if (ms == null) return '--';
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10000 ? 1 : 2)} s` : `${Math.round(ms)} ms`;
}

function formatCost(value) {
  const n = numeric(value);
  if (n == null) return '--';
  if (n === 0) return 'USD 0';
  return `USD ${n < 0.01 ? n.toFixed(6) : n.toFixed(4)}`;
}

function formatBytes(value) {
  const bytes = numeric(value);
  if (bytes == null || bytes < 0) return '--';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

function stats(rows) {
  const elapsed = rows.map((row) => row.elapsed_ms).filter(Number.isFinite);
  return {
    runs: rows.length,
    pass: rows.filter((row) => row.ok).length,
    fail: rows.filter((row) => !row.ok).length,
    median_ms: percentile(elapsed, 0.5),
    p95_ms: percentile(elapsed, 0.95),
    cost: rows.reduce((sum, row) => sum + Number(row.estimated_cost_usd || 0), 0)
  };
}

function statusTex(ok) {
  return ok ? '\\Pass' : '\\Fail';
}

function manualTex(value) {
  if (value === 'pass') return '\\Pass';
  if (value === 'fail') return '\\Fail';
  return '\\Pending';
}

function checkTex(value) {
  if (value === true) return '\\Pass';
  if (value === false) return '\\Fail';
  return '--';
}

function categorySummaryTex(rows) {
  const categories = [
    ...CATEGORY_ORDER,
    ...rows.map((row) => row.category).filter((item) => item && !CATEGORY_ORDER.includes(item))
  ];
  const body = [...new Set(categories)].map((category) => {
    const group = rows.filter((row) => row.category === category);
    if (!group.length) return '';
    const s = stats(group);
    return `${texEscape(category)} & ${s.runs} & ${s.pass} & ${s.fail} & ${formatMs(s.median_ms)} & ${formatMs(s.p95_ms)} & ${formatCost(s.cost)} \\\\`;
  }).filter(Boolean).join('\n');
  return String.raw`\begin{table}[H]
\centering
\caption{按实验阶段汇总的运行数量、自动状态与延迟。}
\label{tab:category-summary}
\small
\begin{tabularx}{\textwidth}{>{\raggedright\arraybackslash}Xrrrrrr}
\toprule
实验阶段 & Runs & Pass & Fail & Median & P95 & Cost \\
\midrule
${body}
\bottomrule
\end{tabularx}
\end{table}`;
}

function endpointSummaryTex(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = `${row.endpoint_name}\u0000${row.routed_model_id || row.model_id}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  const body = [...map.entries()].map(([key, group]) => {
    const [endpoint, model] = key.split('\u0000');
    const s = stats(group);
    return `${texEscape(endpoint || 'Endpoint')} & \\texttt{${texEscape(model || '--')}} & ${s.runs} & ${s.pass} & ${s.fail} & ${formatMs(s.median_ms)} \\\\`;
  }).join('\n');
  return String.raw`\begin{table}[H]
\centering
\caption{端点与模型组合的运行覆盖。}
\small
\begin{tabularx}{\textwidth}{>{\raggedright\arraybackslash}p{0.22\textwidth}>{\raggedright\arraybackslash}Xrrrr}
\toprule
Endpoint & Model & Runs & Pass & Fail & Median \\
\midrule
${body || '-- & -- & 0 & 0 & 0 & -- \\\\'}
\bottomrule
\end{tabularx}
\end{table}`;
}

function capabilityTex(rows) {
  const body = rows.filter((row) => row.category === '回图能力').map((row) => {
    const formats = row.probe.returned_formats.join(', ') || '--';
    return `${texEscape(row.endpoint_name)} & \\texttt{${texEscape(row.routed_model_id || row.model_id)}} & ${texEscape(row.question_name)} & ${statusTex(row.ok)} & ${texEscape(formats)} & ${formatMs(row.elapsed_ms)} \\\\`;
  }).join('\n');
  return String.raw`\subsection{回图能力}
Base64 与 URL 两种返回路径分别进行请求。自动状态记录 HTTP、图片数量及返回格式是否与请求一致。
\begin{table}[H]\centering\small
\begin{tabularx}{\textwidth}{p{0.17\textwidth}Xp{0.19\textwidth}lll}
\toprule Endpoint & Model & Probe & Auto & Returned & Latency \\
\midrule
${body || '\\multicolumn{6}{c}{No data} \\\\'}
\bottomrule\end{tabularx}\end{table}`;
}

function editInputCount(row) {
  const explicit = Math.round(Number(row.edit_input_count || 0));
  if ([1, 2, 4, 8].includes(explicit)) return explicit;
  const match = row.question_id.match(/input-(1|2|4|8)(?:$|[^0-9])/);
  return match ? Number(match[1]) : 0;
}

function editTex(rows) {
  const body = rows.filter((row) => row.category === 'Edit 多图输入').map((row) => {
    return `${texEscape(row.endpoint_name)} & \\texttt{${texEscape(row.routed_model_id || row.model_id)}} & ${editInputCount(row) || '--'} & ${statusTex(row.ok)} & ${manualTex(row.manual_verdict)} & ${formatMs(row.elapsed_ms)} & ${texEscape(row.error_message || '--')} \\\\`;
  }).join('\n');
  return String.raw`\subsection{Edit 多图输入}
Image 1 是编辑目标；其余图片是固定参考物。1/2/4/8 张输入按顺序运行。“Auto”记录接口、数量及格式状态，“Manual”记录当前会话中的人工标记。
\begin{table}[H]\centering\scriptsize
\begin{tabularx}{\textwidth}{p{0.15\textwidth}XrlllX}
\toprule Endpoint & Model & Inputs & Auto & Manual & Latency & Message \\
\midrule
${body || '\\multicolumn{7}{c}{No data} \\\\'}
\bottomrule\end{tabularx}\end{table}`;
}

function matrixCell(rows, quality, size) {
  const group = rows.filter((row) =>
    row.category === 'Quality × Size 矩阵' &&
    row.probe.quality === quality &&
    (row.probe.requested_size || row.probe.size) === size
  );
  if (!group.length) return '--';
  const passed = group.filter((row) => row.ok).length;
  const med = percentile(group.map((row) => row.elapsed_ms).filter(Number.isFinite), 0.5);
  const actual = [...new Set(group.flatMap((row) => row.probe.actual_sizes).filter(Boolean))]
    .slice(0, 2)
    .join('/');
  const mark = passed === group.length ? '\\Pass' : passed === 0 ? '\\Fail' : '\\Mixed';
  return `\\shortstack{${mark} ${passed}/${group.length}\\\\${texEscape(formatMs(med))}\\\\${texEscape(actual || '--')}}`;
}

function matrixTex(rows) {
  const header = MATRIX_SIZES.map((size) => texEscape(size.replace('x', '×'))).join(' & ');
  const body = MATRIX_QUALITIES.map((quality) => {
    return `${texEscape(quality.toUpperCase())} & ${MATRIX_SIZES.map((size) => matrixCell(rows, quality, size)).join(' & ')} \\\\`;
  }).join('\n');
  return String.raw`\subsection{Quality--Size 矩阵}
每个单元格依次显示自动状态、通过运行数、延迟中位数与返回图片的实际像素。显式尺寸按实际像素进行精确匹配；\texttt{auto} 按测试套件中的合法像素条件记录。
\begin{table}[H]\centering
\caption{完整 3x8 Quality--Size 矩阵。}
\label{tab:qs-matrix}
\resizebox{\textwidth}{!}{%
\begin{tabular}{l*{8}{c}}
\toprule Quality & ${header} \\
\midrule
${body}
\bottomrule
\end{tabular}}
\end{table}`;
}

function nScalingTex(rows) {
  const body = rows.filter((row) => row.category === 'n 多图与耗时').map((row) => {
    return `${texEscape(row.endpoint_name)} & \\texttt{${texEscape(row.routed_model_id || row.model_id)}} & ${row.probe.requested_n || '--'} & ${row.probe.returned_n || 0} & ${statusTex(row.ok)} & ${formatMs(row.elapsed_ms)} & ${formatMs(row.probe.ms_per_image)} \\\\`;
  }).join('\n');
  return String.raw`\subsection{输出数量扩展}
\begin{table}[H]\centering\small
\begin{tabularx}{\textwidth}{p{0.18\textwidth}Xrrrrr}
\toprule Endpoint & Model & Requested n & Returned & Auto & Total & Per image \\
\midrule
${body || '\\multicolumn{7}{c}{No data} \\\\'}
\bottomrule\end{tabularx}\end{table}`;
}

function failureTex(rows) {
  const failed = rows.filter((row) => !row.ok || row.manual_verdict === 'fail');
  if (!failed.length) return '本次已执行结果中没有自动 FAIL 或人工 FAIL 标记。';
  const body = failed.map((row) =>
    `${texEscape(row.question_id)} & ${texEscape(row.endpoint_name)} & \\texttt{${texEscape(row.routed_model_id || row.model_id)}} & ${statusTex(row.ok)} / ${manualTex(row.manual_verdict)} & ${texEscape(row.error_message || 'manual FAIL')} \\\\`
  ).join('\n');
  return String.raw`\begin{longtable}{p{0.22\textwidth}p{0.16\textwidth}p{0.20\textwidth}p{0.12\textwidth}p{0.22\textwidth}}
\toprule Probe & Endpoint & Model & Auto/Manual & Recorded message \\
\midrule\endhead
${body}
\bottomrule
\end{longtable}`;
}

function appendixTex(rows) {
  const body = rows.map((row) => {
    const actual = row.probe.actual_sizes.join(', ') || '--';
    return `${texEscape(row.question_id)} & ${texEscape(row.endpoint_name)} & \\texttt{${texEscape(row.routed_model_id || row.model_id)}} & ${statusTex(row.ok)} & ${manualTex(row.manual_verdict)} & ${formatMs(row.elapsed_ms)} & ${texEscape(actual)} \\\\`;
  }).join('\n');
  return String.raw`\scriptsize
\begin{longtable}{p{0.22\textwidth}p{0.15\textwidth}p{0.19\textwidth}llll}
\toprule Probe & Endpoint & Model & Auto & Manual & Latency & Actual size \\
\midrule\endhead
${body}
\bottomrule
\end{longtable}`;
}

function outputSlotCount(row) {
  const requested = Math.max(0, Math.round(Number(row.probe.requested_n || 0)));
  const returned = Math.max(0, Math.round(Number(row.probe.returned_n || 0)));
  return Math.max(1, Math.min(MAX_IMAGES_PER_RESULT, Math.max(requested, returned, row.images.length)));
}

function gridShape(count, kind) {
  if (kind === 'input') return { columns: 4, width: '0.235', height: '31mm' };
  if (count <= 1) return { columns: 1, width: '0.70', height: '86mm' };
  if (count <= 4) return { columns: 2, width: '0.48', height: '54mm' };
  return { columns: 4, width: '0.235', height: '35mm' };
}

function imageCellTex(item, shape) {
  const image = item.file
    ? String.raw`\includegraphics[width=\linewidth,height=${shape.height},keepaspectratio]{${texEscape(item.file)}}`
    : String.raw`\fcolorbox{Rule}{Paper}{\begin{minipage}[c][${shape.height}][c]{0.90\linewidth}
\centering\small\color{Muted}${texEscape(item.note || '无可用图片')}
\end{minipage}}`;
  return String.raw`\begin{minipage}[t]{${shape.width}\textwidth}
\centering
${image}
\par\vspace{1mm}{\scriptsize\textbf{${texEscape(item.title || 'Image')}}\par\color{Muted}${texEscape(item.caption || item.note || '')}}
\end{minipage}`;
}

function imageGridTex(items, kind) {
  if (!items.length) return '';
  const shape = gridShape(items.length, kind);
  return items.map((item, index) => {
    const suffix = (index + 1) % shape.columns === 0 || index === items.length - 1
      ? '\\par\\vspace{3mm}'
      : '\\hfill';
    return `${imageCellTex(item, shape)}${suffix}`;
  }).join('\n');
}

function recordMetadataTex(row) {
  const probe = row.probe;
  const requestedSize = probe.requested_size || probe.size || '--';
  const actualSizes = probe.actual_sizes.join(', ') || '--';
  const formats = probe.returned_formats.join(', ') || '--';
  const totalBytes = probe.actual_bytes.reduce((sum, value) => sum + (Number(value) || 0), 0);
  const requestReturn = `${probe.requested_n == null ? '--' : probe.requested_n} / ${probe.returned_n == null ? '--' : probe.returned_n}`;
  return String.raw`\begin{tabularx}{\textwidth}{>{\bfseries}p{0.17\textwidth}Y>{\bfseries}p{0.17\textwidth}Y}
Endpoint & ${texEscape(row.endpoint_name || '--')} & Model & \texttt{${texEscape(row.routed_model_id || row.model_id || '--')}} \\
Category & ${texEscape(row.category || '--')} & Endpoint type & \texttt{${texEscape(row.endpoint_type || '--')}} \\
Auto / Manual & ${statusTex(row.ok)}\ /\ ${manualTex(row.manual_verdict)} & HTTP / Latency & ${row.response_status == null ? '--' : row.response_status}\ /\ ${texEscape(formatMs(row.elapsed_ms))} \\
Requested / Returned & ${requestReturn} & Format & ${texEscape(probe.requested_format || '--')} / ${texEscape(formats)} \\
Quality / Size & ${texEscape(probe.quality || '--')} / ${texEscape(requestedSize)} & Actual size & ${texEscape(actualSizes)} \\
Output bytes & ${texEscape(totalBytes ? formatBytes(totalBytes) : '--')} & Cost & ${formatCost(row.estimated_cost_usd)} \\
Count / Format / Size & ${checkTex(probe.count_ok)} / ${checkTex(probe.format_ok)} / ${checkTex(probe.size_ok)} & & \\
\end{tabularx}`;
}

function testPointTex(row, record, sequence) {
  const inputs = record && Array.isArray(record.inputs) ? record.inputs : [];
  const outputs = record && Array.isArray(record.outputs)
    ? record.outputs
    : [{ title: 'Output 1', note: '报告中没有可用输出图。', caption: '无可用输出图' }];
  const message = row.error_message
    ? String.raw`\textbf{Recorded message}\quad ${texEscape(row.error_message)}\par`
    : '';
  const inputBlock = inputs.length
    ? String.raw`\textbf{输入图片（${inputs.length}）}\par
\vspace{2mm}
${imageGridTex(inputs, 'input')}`
    : '';
  return String.raw`\filbreak
\subsection{${texEscape(row.question_name || row.question_id)}}
{\small\color{Muted}\texttt{${texEscape(row.question_id)}} \hfill Test point ${sequence}}\par
\vspace{1mm}
${recordMetadataTex(row)}
${message}
\vspace{2mm}
${inputBlock}
\filbreak
\textbf{输出图片（${outputs.length} 个位置）}\par
\vspace{2mm}
${imageGridTex(outputs, 'output')}
\color{Rule}\hrule
\color{Ink}\vspace{4mm}`;
}

function testPointRecordsTex(rows, figures) {
  const records = new Map((figures.records || []).map((record) => [record.rowIndex, record]));
  return rows.map((row, index) => testPointTex(row, records.get(index), index + 1)).join('\n');
}

function imageAvailabilityTex(figures, rows) {
  const records = figures.records || [];
  const inputItems = records.flatMap((record) => record.inputs || []);
  const outputItems = records.flatMap((record) => record.outputs || []);
  const readableInputs = inputItems.filter((item) => item.file).length;
  const readableOutputs = outputItems.filter((item) => item.file).length;
  const unavailableOutputs = outputItems.length - readableOutputs;
  return String.raw`本报告为 ${rows.length} 次已执行运行建立逐测试点记录。Edit 输入位置共 ${inputItems.length} 个，其中 ${readableInputs} 个在排版时可读取；输出位置共 ${outputItems.length} 个，其中 ${readableOutputs} 个在排版时可读取，${unavailableOutputs} 个显示事实占位。

URL 图片会在报告生成阶段重新下载；生成阶段未返回图片字节的位置显示“无可用输出图”。PDF 中 PNG/JPEG 使用原始返回字节，不缩放、不降低质量；WebP 仅为 TeX 兼容性无损转换为 PNG。运行表保留数量、格式、耗时、实际像素和文件大小。`;
}

function buildImageReportTex(report, figures = { records: [], errors: [] }) {
  const rows = report.results;
  const s = stats(rows);
  const uniqueQuestions = new Set(rows.map((row) => row.question_id)).size;
  const models = [...new Set(rows.map((row) => row.routed_model_id || row.model_id).filter(Boolean))];
  const endpoints = [...new Set(rows.map((row) => row.endpoint_name).filter(Boolean))];
  const reviewed = rows.filter((row) => row.manual_verdict).length;
  const manualPass = rows.filter((row) => row.manual_verdict === 'pass').length;
  const generated = new Date(report.generated_at);
  const generatedLabel = Number.isNaN(generated.getTime())
    ? report.generated_at
    : generated.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
  const coverage = `${uniqueQuestions}/${report.expected_probe_count}`;
  const passRate = s.runs ? `${(s.pass / s.runs * 100).toFixed(1)}\\%` : '--';

  return String.raw`\documentclass[UTF8,10pt,a4paper]{ctexart}
\usepackage[margin=18mm,headheight=14pt]{geometry}
\usepackage{graphicx}
\usepackage{booktabs}
\usepackage{array}
\usepackage{longtable}
\usepackage{tabularx}
\usepackage[table]{xcolor}
\usepackage{hyperref}
\usepackage{fancyhdr}
\usepackage{lastpage}
\usepackage{titlesec}
\usepackage{enumitem}
\usepackage{caption}
\usepackage{float}
\usepackage{microtype}

\definecolor{Ink}{HTML}{171717}
\definecolor{Muted}{HTML}{62666D}
\definecolor{Accent}{HTML}{1F4E79}
\definecolor{PassColor}{HTML}{18794E}
\definecolor{FailColor}{HTML}{B42318}
\definecolor{Rule}{HTML}{D8DCE2}
\definecolor{Paper}{HTML}{F5F7FA}
\newcommand{\Pass}{\textcolor{PassColor}{\textbf{PASS}}}
\newcommand{\Fail}{\textcolor{FailColor}{\textbf{FAIL}}}
\newcommand{\Mixed}{\textcolor{Accent}{\textbf{MIXED}}}
\newcommand{\Pending}{\textcolor{Muted}{UNREVIEWED}}
\newcolumntype{Y}{>{\raggedright\arraybackslash}X}
\captionsetup{font=small,labelfont=bf,labelsep=period}
\titleformat{\section}{\Large\bfseries\color{Ink}}{\thesection}{0.65em}{}[\vspace{1mm}\color{Rule}\titlerule]
\titleformat{\subsection}{\large\bfseries\color{Accent}}{\thesubsection}{0.6em}{}
\setlist{leftmargin=*,itemsep=2pt,topsep=3pt}
\setlength{\parindent}{0pt}
\setlength{\parskip}{5pt}
\renewcommand{\arraystretch}{1.18}
\hypersetup{hidelinks,pdftitle={Image 模型测试报告},pdfauthor={Model Quality Test},pdfcreator={Tectonic 0.16.9 / XeTeX}}
\pagestyle{fancy}
\fancyhf{}
\fancyhead[L]{\small\textcolor{Muted}{MODEL QUALITY TEST · IMAGE BENCHMARK}}
\fancyhead[R]{\small\textcolor{Muted}{${texEscape(generatedLabel)}}}
\fancyfoot[C]{\small\textcolor{Muted}{\thepage\ / \pageref{LastPage}}}

\begin{document}
\begin{titlepage}
\color{Ink}
{\small\bfseries\color{Accent} RESEARCH REPORT \hfill IMAGE API EVALUATION}\par
\vspace{8mm}
{\Huge\bfseries Image 模型测试报告\par}
\vspace{3mm}
{\Large\color{Muted} Image Model Test Report\par}
\vspace{5mm}
{\large 回图能力、Edit 多图输入、Quality--Size 矩阵与输出数量扩展\par}
\vspace{8mm}
\color{Accent}\rule{\textwidth}{1.2pt}
\vspace{8mm}

\begin{tabularx}{\textwidth}{>{\bfseries}p{0.24\textwidth}Y}
Generated & ${texEscape(generatedLabel)} \\
Endpoints & ${texEscape(endpoints.join(', ') || '--')} \\
Models & \texttt{${texEscape(models.join(', ') || '--')}} \\
Executed probes & ${coverage} unique probes; ${s.runs} endpoint--model runs \\
Compiler & Tectonic 0.16.9, offline ctex/XeTeX bundle \\
\end{tabularx}

\vfill
\colorbox{Paper}{\parbox{0.94\textwidth}{
\textbf{摘要}\quad 本报告依据当前浏览器会话中的 Image 测试结果生成。实验包含 Base64/URL 回图、1/2/4/8 张输入 Edit、3x8 Quality--Size 参数矩阵以及 \texttt{n=2/4/8} 输出扩展。共记录 ${s.runs} 次运行，自动 PASS 比例为 ${passRate}，延迟中位数为 ${texEscape(formatMs(s.median_ms))}，P95 为 ${texEscape(formatMs(s.p95_ms))}。人工标记已填写 ${reviewed} 项，其中 ${manualPass} 项为 PASS。每个已执行测试点在正文中列出输入图、全部输出图或对应占位。
}}
\vfill
{\small\color{Muted} Generated by Model Quality Test. The TeX source is compiled to PDF with an offline Tectonic bundle.}
\end{titlepage}

\section{测试设计与记录字段}
\begin{enumerate}
\item \textbf{回图能力：}分别请求 \texttt{b64\_json} 与 \texttt{url}，记录返回数量及格式是否与请求一致。
\item \textbf{Edit：}Image 1 为固定场景，其余图片为固定参考物；运行 1/2/4/8 张输入并保留人工 PASS/FAIL 标记。
\item \textbf{Quality--Size：}对 low/medium/high 与 8 种尺寸执行完整矩阵。显式尺寸按返回图片的实际像素记录匹配状态。
\item \textbf{输出扩展：}在 1K low 条件下请求 \texttt{n=2,4,8}，记录总耗时、返回数量和平均每图耗时。
\end{enumerate}
${categorySummaryTex(rows)}
${endpointSummaryTex(rows)}

\section{汇总结果}
${capabilityTex(rows)}
${editTex(rows)}
${matrixTex(rows)}
${nScalingTex(rows)}

\section{图片可用性说明}
${imageAvailabilityTex(figures, rows)}

\clearpage
\section{逐测试点图像记录}
${testPointRecordsTex(rows, figures)}

\section{失败记录}
${failureTex(rows)}

\section{结果概述}
本次报告记录 ${s.runs} 次实际 API 运行，覆盖率为 ${coverage}，自动 PASS 比例为 ${passRate}，估算总成本为 ${formatCost(s.cost)}。各测试点的接口状态、人工标记、耗时、实际像素以及输入和输出图片均按当前会话数据列出。

\clearpage
\appendix
\section{完整运行记录}
${appendixTex(rows)}
\end{document}`;
}

async function sourceBytes(src) {
  const data = String(src || '').match(/^data:image\/(?:png|jpe?g|webp);base64,([\s\S]+)$/i);
  if (data) return Buffer.from(data[1], 'base64');
  return fetchImageBytes(src, 30000);
}

async function writeOriginalImage(buffer, outputBase, declaredMime) {
  const metadata = await sharp(buffer, { failOn: 'none', limitInputPixels: 80_000_000 }).metadata();
  const format = String(metadata.format || '').toLowerCase();
  if (format === 'png' || format === 'jpeg' || format === 'jpg') {
    const ext = format === 'png' ? '.png' : '.jpg';
    const file = `${outputBase}${ext}`;
    fs.writeFileSync(file, buffer);
    return { file: path.basename(file), sourceBytes: buffer.length, converted: false };
  }
  if (format === 'webp' || declaredMime === 'image/webp') {
    const file = `${outputBase}.png`;
    await sharp(buffer, { failOn: 'none', limitInputPixels: 80_000_000 })
      .png({ compressionLevel: 6, adaptiveFiltering: true })
      .toFile(file);
    return { file: path.basename(file), sourceBytes: buffer.length, converted: true };
  }
  throw new Error(`unsupported report image format: ${format || declaredMime || 'unknown'}`);
}

function actualSizeFor(row, image, index) {
  if (image && image.width && image.height) return `${image.width}x${image.height}`;
  return row.probe.actual_sizes[index] || '--';
}

function unavailableOutput(row, index, note) {
  const requested = row.probe.requested_n == null ? '--' : row.probe.requested_n;
  const returned = row.probe.returned_n == null ? row.images.length : row.probe.returned_n;
  return {
    file: null,
    title: `Output ${index + 1}`,
    caption: '无可用输出图',
    note: note || `请求 n=${requested}，记录返回 ${returned} 张；该位置没有图片源。`
  };
}

async function prepareFigures(report, tempDir) {
  const maxInputs = report.results.reduce((max, row) => Math.max(max, editInputCount(row)), 0);
  const fixtures = [];
  const records = [];
  const errors = [];

  for (let index = 0; index < maxInputs; index++) {
    const [file, label, role] = EDIT_FIXTURES[index];
    const outputBase = path.join(tempDir, `fixture-${String(index + 1).padStart(2, '0')}`);
    try {
      const source = fs.readFileSync(path.join(EDIT_ASSET_DIR, file));
      const written = await writeOriginalImage(source, outputBase, 'image/png');
      fixtures.push({ file: written.file, title: label, caption: `${role} · ${formatBytes(source.length)}`, note: '' });
    } catch (error) {
      const note = `报告生成时未能读取输入文件 ${file}：${clipped(error.message, 180)}`;
      fixtures.push({ file: null, title: label, caption: '无可用输入图', note });
      errors.push(note);
    }
  }

  let processedImageFiles = 0;
  const imageJobs = [];
  for (let rowIndex = 0; rowIndex < report.results.length; rowIndex++) {
    const row = report.results[rowIndex];
    const inputs = fixtures.slice(0, editInputCount(row)).map((item) => Object.assign({}, item));
    const outputs = new Array(outputSlotCount(row));
    const record = { rowIndex, inputs, outputs };
    records.push(record);
    const slots = outputSlotCount(row);

    for (let imageIndex = 0; imageIndex < slots; imageIndex++) {
      const image = row.images[imageIndex];
      if (!image) {
        outputs[imageIndex] = unavailableOutput(row, imageIndex);
        continue;
      }
      if (processedImageFiles >= MAX_REPORT_IMAGE_FILES) {
        outputs[imageIndex] = unavailableOutput(
          row,
          imageIndex,
          `报告已处理 ${MAX_REPORT_IMAGE_FILES} 个输出图片文件；该位置未读取图片字节。`
        );
        continue;
      }
      processedImageFiles++;
      const outputBase = path.join(tempDir, `output-${String(rowIndex + 1).padStart(3, '0')}-${String(imageIndex + 1).padStart(2, '0')}`);
      imageJobs.push({ image, imageIndex, outputBase, record, row });
    }
  }

  let nextJob = 0;
  async function imageWorker() {
    while (nextJob < imageJobs.length) {
      const job = imageJobs[nextJob++];
      try {
        const bytes = await sourceBytes(job.image.src);
        const written = await writeOriginalImage(bytes, job.outputBase, job.image.mime_type);
        const actual = actualSizeFor(job.row, job.image, job.imageIndex);
        job.record.outputs[job.imageIndex] = {
          file: written.file,
          title: `Output ${job.imageIndex + 1}`,
          caption: `${job.image.response_format || job.row.probe.returned_formats[job.imageIndex] || 'image'} · ${actual} · ${formatBytes(job.image.byte_size || written.sourceBytes)}${written.converted ? ' · WebP→PNG lossless' : ''}`,
          note: ''
        };
      } catch (error) {
        const note = `报告生成时未能读取 Output ${job.imageIndex + 1}：${clipped(error.message, 180)}`;
        job.record.outputs[job.imageIndex] = unavailableOutput(job.row, job.imageIndex, note);
        errors.push(`${job.row.question_id} / Output ${job.imageIndex + 1}: ${clipped(error.message, 240)}`);
      }
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(REPORT_IMAGE_CONCURRENCY, imageJobs.length) },
    imageWorker
  ));

  return { fixtures, records, errors, originalQuality: true };
}

function ensureRuntimeBinary() {
  if (!fs.existsSync(TECTONIC_SOURCE)) throw new Error('Tectonic binary is missing; run npm install');
  if (!fs.existsSync(path.join(TECTONIC_CACHE, 'Tectonic', 'formats'))) {
    throw new Error('Tectonic offline cache is missing; run npm install');
  }
  if (!fs.existsSync(TECTONIC_RUNTIME) ||
      fs.statSync(TECTONIC_RUNTIME).size !== fs.statSync(TECTONIC_SOURCE).size) {
    const temp = `${TECTONIC_RUNTIME}.${process.pid}`;
    fs.copyFileSync(TECTONIC_SOURCE, temp);
    fs.chmodSync(temp, 0o755);
    try {
      fs.renameSync(temp, TECTONIC_RUNTIME);
    } catch (error) {
      fs.rmSync(temp, { force: true });
    }
  }
  fs.chmodSync(TECTONIC_RUNTIME, 0o755);
  return TECTONIC_RUNTIME;
}

function runTectonic(texPath, outputDir) {
  const binary = ensureRuntimeBinary();
  return new Promise((resolve, reject) => {
    execFile(binary, ['-X', 'compile', '--only-cached', '--untrusted', texPath, '--outdir', outputDir], {
      cwd: outputDir,
      env: Object.assign({}, process.env, { XDG_CACHE_HOME: TECTONIC_CACHE }),
      timeout: 120000,
      maxBuffer: 16 * 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || stdout || error.message).slice(-5000);
        const lineMatch = detail.match(/image-quality-report\.tex:(\d+)/);
        let sourceLine = '';
        if (lineMatch) {
          const lines = fs.readFileSync(texPath, 'utf8').split('\n');
          const lineNumber = Number(lineMatch[1]);
          const from = Math.max(0, lineNumber - 9);
          const context = lines.slice(from, lineNumber)
            .map((line, index) => `${from + index + 1}: ${line}`)
            .join('\n');
          sourceLine = `\nTeX context:\n${context}`;
        }
        reject(new Error(`TeX compilation failed: ${detail}${sourceLine}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function compileTex(report, figures, tempDir) {
  const texPath = path.join(tempDir, 'image-quality-report.tex');
  const pdfPath = path.join(tempDir, 'image-quality-report.pdf');
  fs.rmSync(pdfPath, { force: true });
  const tex = buildImageReportTex(report, figures);
  fs.writeFileSync(texPath, tex);
  await runTectonic(texPath, tempDir);
  if (!fs.existsSync(pdfPath)) throw new Error('TeX compilation completed without a PDF');
  return { pdf: fs.readFileSync(pdfPath), tex };
}

async function compileImageReport(input) {
  const report = sanitizeImageReport(input);
  if (!report.results.length) throw new Error('No Image test results were supplied');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mqt-image-report-'));
  try {
    const figures = await prepareFigures(report, tempDir);
    const compiled = await compileTex(report, figures, tempDir);
    if (compiled.pdf.length > MAX_PDF_BYTES) {
      throw new Error(`Generated PDF is too large (${compiled.pdf.length} bytes)`);
    }
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13).replace('T', '-');
    return {
      pdf: compiled.pdf,
      tex: compiled.tex,
      filename: `image-quality-report-${stamp}.pdf`,
      report,
      figures
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

module.exports = {
  MAX_PDF_BYTES,
  buildImageReportTex,
  compileImageReport,
  sanitizeImageReport
};
