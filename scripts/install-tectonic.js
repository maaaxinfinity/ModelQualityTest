const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const VENDOR_DIR = path.join(ROOT, 'vendor', 'tectonic');
const BINARY_PATH = path.join(VENDOR_DIR, 'tectonic');
const CACHE_DIR = path.join(VENDOR_DIR, 'cache');
const MARKER_PATH = path.join(VENDOR_DIR, 'install.json');
const VERSION = '0.16.9';
const ARCHIVE_URL = 'https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.16.9/tectonic-0.16.9-x86_64-unknown-linux-musl.tar.gz';
const ARCHIVE_SHA256 = '60b13a0826ae7ad9ce34b4a2df06bff2cfcfa6dda8a915477c0cbb84e1a4a902';
const CACHE_REVISION = 5;

const WARMUP_TEX = String.raw`\documentclass[UTF8,10pt,a4paper]{ctexart}
\usepackage[margin=20mm]{geometry}
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
\hypersetup{hidelinks,pdftitle={Image 模型质量测试报告}}
\pagestyle{fancy}
\fancyhf{}
\fancyfoot[C]{\thepage/\pageref{LastPage}}
\titleformat{\section}{\large\bfseries}{\thesection}{0.6em}{}
\begin{document}
\section{图像模型质量评估}
中文字体与学术排版资源预热。
\newcommand{\warmfontsize}[1]{#1
  {\rmfamily\mdseries R}\quad{\rmfamily\bfseries B}\quad{\rmfamily\itshape I}\quad
  {\sffamily\mdseries S}\quad{\sffamily\bfseries SB}\quad
  {\ttfamily\mdseries M}\quad{\ttfamily\bfseries MB}\par}
\warmfontsize{\tiny}
\warmfontsize{\scriptsize}
\warmfontsize{\small}
\warmfontsize{\normalsize}
\warmfontsize{\large}
\warmfontsize{\Large}
\warmfontsize{\LARGE}
\warmfontsize{\huge}
\warmfontsize{\Huge}
{\fontsize{6}{7}\selectfont
  {\rmfamily\mdseries six point}\quad
  {\rmfamily\bfseries six point bold}\quad
  {\rmfamily\itshape six point italic}\quad
  six point sample\par}
{\scriptsize $x_i^2+n=8$}\quad
{\small $x_i^2+n=8$}\quad
{\normalsize $x_i^2+n=8$}\quad
{\large $x_i^2+n=8$}\par
\begin{table}[H]\centering\caption{指标摘要}
\begin{tabularx}{\textwidth}{Xrr}\toprule 指标 & 通过 & 耗时\\\midrule Edit & 1 & 1.2 s\\\bottomrule\end{tabularx}
\end{table}
\begin{longtable}{ll}\toprule 模型 & 状态\\\midrule\endhead GPT Image & PASS\\\bottomrule\end{longtable}
\begin{enumerate}[leftmargin=*]\item 可复现。\end{enumerate}
\end{document}`;

function ready() {
  if (!fs.existsSync(BINARY_PATH) || !fs.existsSync(MARKER_PATH)) return false;
  if (!fs.existsSync(path.join(CACHE_DIR, 'Tectonic', 'formats'))) return false;
  try {
    const marker = JSON.parse(fs.readFileSync(MARKER_PATH, 'utf8'));
    return marker.version === VERSION &&
      marker.archive_sha256 === ARCHIVE_SHA256 &&
      marker.cache_revision === CACHE_REVISION;
  } catch (error) {
    return false;
  }
}

async function install() {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    console.warn(`[tectonic] skipping binary install on ${process.platform}/${process.arch}; PDF reports compile on Vercel linux/x64`);
    return;
  }
  if (ready()) {
    fs.chmodSync(BINARY_PATH, 0o755);
    console.log(`[tectonic] ${VERSION} and offline ctex cache are ready`);
    return;
  }

  const binaryPresent = fs.existsSync(BINARY_PATH) && fs.statSync(BINARY_PATH).size > 20 * 1024 * 1024;
  if (!binaryPresent) fs.rmSync(VENDOR_DIR, { recursive: true, force: true });
  fs.mkdirSync(VENDOR_DIR, { recursive: true });
  const archivePath = path.join(os.tmpdir(), `tectonic-${VERSION}-${process.pid}.tar.gz`);
  const warmDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mqt-tectonic-warm-'));
  try {
    if (!binaryPresent) {
      console.log(`[tectonic] downloading pinned ${VERSION} musl binary`);
      const response = await fetch(ARCHIVE_URL, { redirect: 'follow' });
      if (!response.ok) throw new Error(`download returned HTTP ${response.status}`);
      const archive = Buffer.from(await response.arrayBuffer());
      const digest = crypto.createHash('sha256').update(archive).digest('hex');
      if (digest !== ARCHIVE_SHA256) throw new Error(`archive checksum mismatch: ${digest}`);
      fs.writeFileSync(archivePath, archive);
      execFileSync('tar', ['-xzf', archivePath, '-C', VENDOR_DIR]);
    } else {
      console.log(`[tectonic] reusing pinned ${VERSION} musl binary`);
    }
    fs.chmodSync(BINARY_PATH, 0o755);

    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const texPath = path.join(warmDir, 'warmup.tex');
    fs.writeFileSync(texPath, WARMUP_TEX);
    const env = Object.assign({}, process.env, { XDG_CACHE_HOME: CACHE_DIR });
    console.log('[tectonic] warming ctex, table, figure, and typography resources');
    execFileSync(BINARY_PATH, ['-X', 'compile', '--untrusted', texPath, '--outdir', warmDir], {
      env,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024
    });
    execFileSync(BINARY_PATH, ['-X', 'compile', '--only-cached', '--untrusted', texPath, '--outdir', warmDir], {
      env,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024
    });
    fs.writeFileSync(MARKER_PATH, JSON.stringify({
      version: VERSION,
      archive_sha256: ARCHIVE_SHA256,
      cache_revision: CACHE_REVISION,
      cache_mode: 'offline',
      generated_at: new Date().toISOString()
    }, null, 2));
    console.log(`[tectonic] offline cache ready (${Math.round(directoryBytes(CACHE_DIR) / 1024 / 1024)} MB)`);
  } finally {
    fs.rmSync(archivePath, { force: true });
    fs.rmSync(warmDir, { recursive: true, force: true });
  }
}

function directoryBytes(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    total += entry.isDirectory() ? directoryBytes(target) : fs.statSync(target).size;
  }
  return total;
}

install().catch((error) => {
  console.error(`[tectonic] install failed: ${error.message}`);
  process.exitCode = 1;
});
