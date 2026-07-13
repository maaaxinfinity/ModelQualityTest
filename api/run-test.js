const { ensureSchema, query } = require('./_lib/db');
const { sendJson, sendMethodNotAllowed, readJson } = require('./_lib/http');
const { randomId, requireUser } = require('./_lib/auth');
const {
  buildUpstreamRequest,
  extractImageArtifacts,
  extractRoutedModel,
  fetchOnce,
  inspectImageDimensions,
  normalizeGroup,
  normalizeUsage,
  sanitizePayload,
  summarizeImageProbe
} = require('./_lib/providers');
const { estimateCostForRun } = require('./_lib/pricing');

async function logRun(row) {
  await query(
    `insert into test_runs (
      id, batch_id, user_id, model_group, provider, model_id, routed_model_id,
      question_id, question_name, endpoint_type, request_endpoint, request_body,
      response_status, response_headers, response_body, ok, elapsed_ms, usage_json,
      estimated_cost_usd, cost_source, error_message
    ) values (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14::jsonb,$15::jsonb,
      $16,$17,$18::jsonb,$19,$20,$21
    )`,
    [
      row.id,
      row.batch_id || null,
      row.user_id,
      row.model_group,
      row.provider,
      row.model_id,
      row.routed_model_id || null,
      row.question_id,
      row.question_name,
      row.endpoint_type,
      row.request_endpoint || null,
      JSON.stringify(sanitizePayload(row.request_body || {})),
      row.response_status || null,
      JSON.stringify(row.response_headers || {}),
      JSON.stringify(sanitizePayload(row.response_body || {})),
      !!row.ok,
      row.elapsed_ms || null,
      JSON.stringify(row.usage_json || {}),
      row.estimated_cost_usd,
      row.cost_source || null,
      row.error_message || null
    ]
  );
}

async function executeOne(question, cfg, user, batchId) {
  const groupName = normalizeGroup(question.group || cfg.group);
  const provider = String(question.provider || groupName).toLowerCase();
  const request = buildUpstreamRequest(question, cfg);
  const response = await fetchOnce(request, Number(cfg.timeout || question.timeout || 600000));
  const body = response.json || { raw_text: response.text };
  const sanitizedBody = sanitizePayload(body);
  const cleanBody = sanitizedBody && typeof sanitizedBody === 'object'
    ? sanitizedBody
    : { value: sanitizedBody };
  const usage = normalizeUsage(body, groupName, question, request.body);
  const images = groupName === 'Image' ? extractImageArtifacts(body, request.body) : [];
  let imageProbe = null;
  let imageValidationError = null;
  if (groupName === 'Image') {
    const validateSize = !!(question.validate && question.validate.size);
    let dimensionProbeMs = null;
    if (response.ok && images.length) {
      const startedAt = Date.now();
      await inspectImageDimensions(images);
      dimensionProbeMs = Date.now() - startedAt;
    }
    const summary = summarizeImageProbe(images, request.body, response.elapsedMs, {
      validateSize,
      dimensionProbeMs
    });
    imageProbe = summary.probe;
    imageValidationError = summary.error;
    usage.requested_image_count = imageProbe.requested_n;
    usage.returned_image_count = images.length;
    if (request.body.input_image_count) usage.input_image_count = request.body.input_image_count;
    cleanBody._image_probe = imageProbe;
  }
  const modelId = request.modelId || request.body.model || cfg.model || question.model;
  const routedModel = extractRoutedModel(body, response.headers, modelId);
  const cost = await estimateCostForRun(groupName, routedModel || modelId, usage);
  const resultOk = response.ok && !imageValidationError;
  const result = {
    id: randomId('run'),
    batch_id: batchId || null,
    user_id: user.id,
    model_group: groupName,
    provider,
    model_id: modelId,
    routed_model_id: routedModel,
    question_id: question.id,
    question_name: question.name || question.id,
    endpoint_type: request.endpointType,
    request_endpoint: request.endpoint,
    request_body: request.body,
    response_status: response.status,
    response_headers: response.headers,
    response_body: cleanBody,
    ok: resultOk,
    elapsed_ms: response.elapsedMs,
    usage_json: usage,
    images: groupName === 'Image' ? images : undefined,
    image_probe: imageProbe,
    estimated_cost_usd: cost.estimated_cost_usd,
    cost_source: cost.cost_source,
    error_message: response.ok
      ? imageValidationError
      : (body.error && (body.error.message || body.error.type)) || response.statusText || 'upstream_error'
  };
  await logRun(result);
  return result;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return sendMethodNotAllowed(res, ['POST']);
  await ensureSchema();
  const user = await requireUser(req, res);
  if (!user) return;
  let payload;
  try {
    payload = await readJson(req);
  } catch (e) {
    return sendJson(res, 400, { error: 'bad_json', detail: e.message });
  }
  if (payload.action === 'image_report') {
    try {
      const { compileImageReport } = require('./_lib/image-report');
      const { storeImageReport } = require('./_lib/report-storage');
      const report = await compileImageReport(payload.report);
      const stored = await storeImageReport(report.pdf, report.filename);
      return sendJson(res, 200, { ok: true, report: stored });
    } catch (error) {
      console.error('image_report_failed', error && (error.stack || error.message || error));
      return sendJson(res, 500, { error: 'image_report_failed', detail: error.message });
    }
  }
  const question = payload.question || {};
  const cfg = payload.cfg || {};
  if (!question.id) return sendJson(res, 400, { error: 'missing_question' });
  const batchId = payload.batchId || randomId('batch');
  try {
    const load = question.load || {};
    const repeat = Math.max(1, Math.min(Number(load.requests || question.repeat || 1), 20));
    const concurrency = Math.max(1, Math.min(Number(load.concurrency || 1), 5));
    if (repeat === 1) {
      const result = await executeOne(question, cfg, user, batchId);
      return sendJson(res, 200, { ok: result.ok, result });
    }

    const results = [];
    let next = 0;
    async function worker() {
      while (next < repeat) {
        const idx = next++;
        const clone = Object.assign({}, question, {
          id: `${question.id}#${idx + 1}`,
          name: `${question.name || question.id} #${idx + 1}`
        });
        results[idx] = await executeOne(clone, cfg, user, batchId);
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, repeat) }, worker));
    const ok = results.every((r) => r.ok);
    const totalCost = results.reduce((sum, r) => sum + Number(r.estimated_cost_usd || 0), 0);
    return sendJson(res, 200, {
      ok,
      result: {
        id: randomId('run_summary'),
        batch_id: batchId,
        model_group: normalizeGroup(question.group || cfg.group),
        provider: String(question.provider || question.group || cfg.group || '').toLowerCase(),
        model_id: cfg.model || question.model,
        question_id: question.id,
        question_name: question.name || question.id,
        endpoint_type: 'load_test',
        ok,
        elapsed_ms: results.reduce((sum, r) => sum + Number(r.elapsed_ms || 0), 0),
        response_status: ok ? 200 : 500,
        response_body: { attempts: results.map((r) => ({ id: r.id, ok: r.ok, status: r.response_status, elapsed_ms: r.elapsed_ms, cost: r.estimated_cost_usd })) },
        usage_json: { attempts: results.length },
        estimated_cost_usd: totalCost,
        cost_source: 'sum(child runs)'
      }
    });
  } catch (e) {
    return sendJson(res, 500, { error: 'run_failed', detail: e.message });
  }
};
