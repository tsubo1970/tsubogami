// ページをPDF化し、最新版と日付入りの過去10日分を out/ に保存するスクリプト
// URLはコードに書かず、GitHub Secrets の TSUBOY_URL から受け取る
import puppeteer from 'puppeteer';
import { PDFDocument } from 'pdf-lib';
import fs from 'node:fs/promises';
import path from 'node:path';

const url = process.env.TSUBOY_URL;
if (!url) {
  console.error('TSUBOY_URL が設定されていません（GitHub の Secrets を確認してください）');
  process.exit(1);
}

const OUT_DIR = process.argv[2] || 'out';
const KEEP_DAYS = 10;                                 // 日付入りファイルを残す日数（今日を含む）
const WAIT_MS = Number(process.env.WAIT_MS || 8000);  // 表示が整うまでの追加待ち時間（ミリ秒）
const NAME = 'tsubogami';

// PDFに残ってはいけない文字列（URL全体と鍵の値）
const parsed = new URL(url);
const secrets = [url, parsed.search, parsed.searchParams.get('tsubogami')]
  .filter((s) => s && s.length >= 8);

// 日本時間の日付 YYYYMMDD
const jstYmd = (offsetDays = 0) =>
  new Date(Date.now() + 9 * 3600 * 1000 - offsetDays * 86400 * 1000)
    .toISOString().slice(0, 10).replace(/-/g, '');
const today = jstYmd(0);
const cutoff = jstYmd(KEEP_DAYS - 1);

// 1. ページを開いてPDF化
const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
let pdfBytes;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1800 });
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 90_000 });
  await new Promise((r) => setTimeout(r, WAIT_MS));

  // 鍵付きURLへのリンクがあれば外す
  await page.evaluate((secrets) => {
    for (const a of document.querySelectorAll('a[href]')) {
      if (secrets.some((s) => a.href.includes(s))) a.removeAttribute('href');
    }
  }, secrets);

  pdfBytes = await page.pdf({
    format: 'A4',
    printBackground: true,
    displayHeaderFooter: false, // URLや日時をヘッダー・フッターに印字しない
    margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' },
  });
} finally {
  await browser.close();
}

// 2. メタデータを整理（元URLが入り込まないように）
const doc = await PDFDocument.load(pdfBytes);
doc.setTitle(`${NAME} ${today}`);
doc.setAuthor('');
doc.setSubject('');
doc.setKeywords([]);
doc.setCreator('');
doc.setProducer('');
const finalBytes = await doc.save({ useObjectStreams: false });

// 3. 念のため、秘密の文字列がPDFに残っていないか確認（残っていたら保存せず失敗させる）
const raw = Buffer.from(finalBytes).toString('latin1');
if (secrets.some((s) => raw.includes(s))) {
  console.error('PDF内に秘密のURLが含まれていたため、保存を中止しました');
  process.exit(1);
}

// 4. 保存（最新版＋日付入り）
await fs.mkdir(OUT_DIR, { recursive: true });
await fs.writeFile(path.join(OUT_DIR, `${NAME}.pdf`), finalBytes);
await fs.writeFile(path.join(OUT_DIR, `${NAME}-${today}.pdf`), finalBytes);

// 5. 10日より前の日付入りファイルを削除
for (const f of await fs.readdir(OUT_DIR)) {
  const m = f.match(new RegExp(`^${NAME}-(\\d{8})\\.pdf$`));
  if (m && m[1] < cutoff) {
    await fs.unlink(path.join(OUT_DIR, f));
    console.log(`削除: ${f}`);
  }
}
console.log(`保存: ${NAME}.pdf, ${NAME}-${today}.pdf（${(finalBytes.length / 1024).toFixed(0)} KB）`);
