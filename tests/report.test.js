const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

global.window = global;
require('../questions.js');

const {
  MAX_PDF_BYTES,
  compileImageReport
} = require('../api/_lib/image-report');

const fixtureFiles = [
  'scene-b.png',
  'object-fox.png',
  'object-orb.png',
  'object-rocket.png',
  'object-cactus.png',
  'object-robot.png',
  'object-compass.png',
  'object-mug.png'
];
const fixtureUris = fixtureFiles.map((file) => {
  const bytes = fs.readFileSync(path.join(__dirname, '..', 'assets', 'image-edit', file));
  return `data:image/png;base64,${bytes.toString('base64')}`;
});

function reportRow(question, questionIndex) {
  const requestedN = Number(question.image && question.image.n || 1);
  const requestedSize = String(question.image && question.image.size || '1024x1024');
  const actualSize = requestedSize === 'auto' ? '1024x1024' : requestedSize;
  const responseFormat = String(question.image && question.image.response_format || 'url');
  const images = Array.from({ length: requestedN }, (_, imageIndex) => ({
    src: fixtureUris[(questionIndex + imageIndex) % fixtureUris.length],
    index: imageIndex,
    response_format: responseFormat,
    width: Number(actualSize.split('x')[0]) || 1024,
    height: Number(actualSize.split('x')[1]) || 1024,
    mime_type: 'image/png'
  }));
  return {
    question_id: question.id,
    question_name: question.name,
    category: question.category,
    endpoint_name: 'Academic report test endpoint',
    model_id: 'selected-image-model',
    routed_model_id: 'selected-image-model',
    endpoint_type: question.endpoint_type,
    edit_input_count: Array.isArray(question.edit_inputs) ? question.edit_inputs.length : null,
    ok: true,
    response_status: 200,
    elapsed_ms: 1200 + questionIndex * 37,
    estimated_cost_usd: 0.001 + questionIndex * 0.00001,
    error_message: '',
    manual_verdict: question.endpoint_type === 'openai_image_edits' ? 'pass' : null,
    probe: {
      requested_n: requestedN,
      returned_n: requestedN,
      requested_format: responseFormat,
      returned_formats: Array(requestedN).fill(responseFormat),
      quality: question.image && question.image.quality,
      size: requestedSize,
      requested_size: requestedSize,
      actual_sizes: Array(requestedN).fill(actualSize),
      elapsed_ms: 1200 + questionIndex * 37,
      ms_per_image: Math.round((1200 + questionIndex * 37) / requestedN),
      count_ok: true,
      format_ok: true,
      size_ok: true
    },
    images
  };
}

async function main() {
  const imageQuestions = QUESTIONS.filter((question) => question.group === 'Image');
  const input = {
    generated_at: '2026-07-11T00:00:00.000Z',
    expected_probe_count: imageQuestions.length,
    results: imageQuestions.map(reportRow)
  };
  const generated = await compileImageReport(input);

  assert.equal(generated.report.results.length, 33);
  assert.equal(generated.figures.records.length, 33);
  assert.equal(generated.figures.records.flatMap((record) => record.outputs).length, 44);
  assert.deepEqual(
    generated.report.results
      .map((row, index) => ({ row, record: generated.figures.records[index] }))
      .filter(({ row }) => row.category === 'Edit 多图输入')
      .map(({ record }) => record.inputs.length),
    [1, 2, 4, 8]
  );
  assert(generated.figures.records.flatMap((record) => record.outputs).every((item) => item.file));
  for (const question of imageQuestions) {
    assert(generated.tex.includes(question.id), `TeX missing test point ${question.id}`);
  }
  for (const record of generated.figures.records) {
    for (const output of record.outputs) {
      assert(generated.tex.includes(output.file), `TeX missing output file ${output.file}`);
    }
  }
  for (const phrase of ['风险', '建议', '优先级', '代表性']) {
    assert(!generated.tex.includes(phrase), `generated TeX contains ${phrase}`);
  }
  assert.equal(generated.pdf.subarray(0, 4).toString('ascii'), '%PDF');
  assert(generated.pdf.length <= MAX_PDF_BYTES, `PDF exceeds ${MAX_PDF_BYTES} bytes`);

  const pdfPath = '/tmp/model-quality-image-report-test.pdf';
  const texPath = '/tmp/model-quality-image-report-test.tex';
  fs.writeFileSync(pdfPath, generated.pdf);
  fs.writeFileSync(texPath, generated.tex);
  console.log(`report test ok - ${generated.pdf.length} bytes - ${pdfPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
