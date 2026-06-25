const { Inngest } = require('inngest');
const { serve } = require('inngest/express');
const { getServiceAccountToken } = require('./auth-helper');
const sharp = require('sharp');

const inngest = new Inngest({
  id: 'vitrio-ai',
  eventKey: process.env.INNGEST_EVENT_KEY,
});

const BUCKET = `${process.env.FIREBASE_PROJECT_ID}.firebasestorage.app`;

// ── Firestore: lê documento ──────────────────────────────
async function firestoreGet(accessToken, docPath) {
  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${process.env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${docPath}`,
    { headers: { 'Authorization': `Bearer ${accessToken}` } }
  );
  if (!res.ok) throw new Error(`Firestore GET falhou (${res.status}): ${await res.text()}`);
  return res.json();
}

// ── Firestore: atualiza campos específicos ───────────────
async function updateJob(accessToken, jobId, updates) {
  const fields = {};
  const fieldPaths = [];

  Object.entries(updates).forEach(([k, v]) => {
    const fieldName = (k === 'status' || k === 'updatedAt') ? k : `photo_${k}`;
    fieldPaths.push(fieldName);
    if (k === 'status')    fields[fieldName] = { stringValue: v };
    else if (k === 'updatedAt') fields[fieldName] = { integerValue: v.toString() };
    else                   fields[fieldName] = { stringValue: v };
  });

  const maskParams = fieldPaths.map(f => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join('&');

  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${process.env.FIREBASE_PROJECT_ID}/databases/(default)/documents/jobs/${jobId}?${maskParams}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify({ fields })
    }
  );

  if (!res.ok) console.error('updateJob erro:', res.status, await res.text());
}

// ── Storage: baixa imagem → base64 ──────────────────────
async function downloadFromStorage(accessToken, filePath) {
  const encoded = encodeURIComponent(filePath);
  const url     = `https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encoded}?alt=media`;

  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });
  if (!res.ok) throw new Error(`Storage download falhou (${res.status}): ${filePath}`);

  const buffer = await res.arrayBuffer();
  return Buffer.from(buffer).toString('base64');
}

// ── Comprime PNG/qualquer formato → JPEG 0.85 via sharp ──
async function comprimirParaJpeg(b64) {
  try {
    const buffer = Buffer.from(b64, 'base64');
    const compressed = await sharp(buffer)
      .jpeg({ quality: 93, progressive: true })
      .toBuffer();
    return compressed.toString('base64');
  } catch (e) {
    console.warn('Compressão sharp falhou, usando original:', e.message);
    return b64; // fallback sem compressão
  }
}

// ── Storage: salva base64 → URL ──────────────────────────
async function salvarImagem(accessToken, jobId, photoNum, b64) {
  const filePath = `jobs/${jobId}/photo_${photoNum}.jpg`;
  const encoded  = encodeURIComponent(filePath);
  const url      = `https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o?uploadType=media&name=${encoded}`;

  // Comprime antes de salvar — PNG 1.5MB → JPEG ~300-500KB
  const b64Comprimido = await comprimirParaJpeg(b64);
  const buffer = Buffer.from(b64Comprimido, 'base64');

  const res = await fetch(url, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type':  'image/jpeg',
    },
    body: buffer
  });

  if (!res.ok) throw new Error(`Storage upload falhou (${res.status}): ${await res.text()}`);

  return `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encoded}?alt=media`;
}

// ── Análise técnica da peça ──────────────────────────────
async function analisarPeca(imageBase64) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
     model: 'gpt-4.1',
      max_tokens: 400,
      messages: [{
        role:    'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
          { type: 'text', text: `Analise esta joia e retorne APENAS JSON:
{"metal":"ouro|prata|rose_gold","acabamento":"polido|fosco","pedras":true,"tipo_pedra":"cristal|zirconia|perola|sem_pedra","quantidade_pedras":0,"perolas":false,"quantidade_perolas":0,"tipo_elo":"retangular|oval|figaro|sem_elo","espessura_elo":"fina|media|grossa","fecho":"lagosta|mola|gaveta|sem_fecho","pingente":false,"tipo_pingente":"sem_pingente","gravacao":false,"detalhes_extras":""}` }
        ]
      }]
    })
  });
  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || '{}';
  try { return JSON.parse(text.replace(/```json|```/g, '').trim()); }
  catch { return {}; }
}

function montarDescricao(analise) {
  const p = [];
  if (analise.metal) p.push(`metal: ${analise.metal}`);
  if (analise.acabamento) p.push(`acabamento ${analise.acabamento}`);
  if (analise.pedras && analise.tipo_pedra !== 'sem_pedra') p.push(`${analise.quantidade_pedras} pedra(s) ${analise.tipo_pedra}`);
  if (analise.perolas) p.push(`${analise.quantidade_perolas} pérola(s)`);
  if (analise.tipo_elo && analise.tipo_elo !== 'sem_elo') p.push(`elo ${analise.tipo_elo} ${analise.espessura_elo}`);
  if (analise.fecho && analise.fecho !== 'sem_fecho') p.push(`fecho ${analise.fecho}`);
  if (analise.pingente && analise.tipo_pingente !== 'sem_pingente') p.push(`pingente ${analise.tipo_pingente}`);
  if (analise.gravacao) p.push('com gravação');
  if (analise.detalhes_extras) p.push(analise.detalhes_extras);
  return p.length > 0 ? `\nCaracterísticas: ${p.join(', ')}.` : '';
}

// ── Fallback FLUX ────────────────────────────────────────
async function gerarFLUX(prompt, imageBase64) {
  if (!process.env.REPLICATE_API_KEY) throw new Error('REPLICATE_API_KEY não configurada.');

  const startRes = await fetch('https://api.replicate.com/v1/models/black-forest-labs/flux-redux-dev/predictions', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${process.env.REPLICATE_API_KEY}`,
      'Prefer':        'wait'
    },
    body: JSON.stringify({
      input: {
        redux_image:    `data:image/jpeg;base64,${imageBase64}`,
        prompt,
        num_outputs:    1,
        aspect_ratio:   '1:1',
        output_format:  'webp',
        output_quality: 90
      }
    })
  });

  if (!startRes.ok) throw new Error(`FLUX erro: ${startRes.status}`);
  const prediction = await startRes.json();

  if (prediction.output?.[0]) {
    const res = await fetch(prediction.output[0]);
    const buffer = await res.arrayBuffer();
    return Buffer.from(buffer).toString('base64');
  }

  const pollUrl = prediction.urls?.get;
  if (!pollUrl) throw new Error('FLUX: URL de polling não encontrada.');

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const pollRes = await fetch(pollUrl, {
      headers: { 'Authorization': `Bearer ${process.env.REPLICATE_API_KEY}` }
    });
    const poll = await pollRes.json();
    if (poll.status === 'succeeded' && poll.output?.[0]) {
      const res = await fetch(poll.output[0]);
      const buffer = await res.arrayBuffer();
      return Buffer.from(buffer).toString('base64');
    }
    if (poll.status === 'failed') throw new Error('FLUX: geração falhou.');
  }
  throw new Error('FLUX: timeout no polling.');
}

// ── Geração de foto (OpenAI + fallback FLUX) ─────────────
async function gerarFoto(prompt, imageBase64, descricao = '', retries = 3) {
  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        input: [{
          role:    'user',
          content: [
            { type: 'input_image', image_url: `data:image/png;base64,${imageBase64}` },
            { type: 'input_text', text: `Reproduza EXATAMENTE este produto. Aplique: ${prompt + descricao}` }
          ]
        }],
        tools: [{ type: 'image_generation', size: '1024x1024' }]
      })
    });

    if (response.status === 429 && retries > 0) {
      await new Promise(r => setTimeout(r, 15000));
      return gerarFoto(prompt, imageBase64, descricao, retries - 1);
    }

    if (!response.ok) throw new Error(`OpenAI ${response.status}`);
    const data = await response.json();
    const img  = data.output?.find(o => o.type === 'image_generation_call');
    if (!img) throw new Error('Imagem não gerada');
    return img.result;

  } catch (openaiError) {
    console.warn('OpenAI falhou, tentando FLUX:', openaiError.message);
    return gerarFLUX(prompt, imageBase64);
  }
}

// ── Limpeza automática de jobs antigos (24h) ─────────────
async function limparJobsAntigos(accessToken) {
  try {
    const vinte4h = Date.now() - (24 * 60 * 60 * 1000);

    const res = await fetch(
      `https://firestore.googleapis.com/v1/projects/${process.env.FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery`,
      {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${accessToken}`
        },
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId: 'jobs' }],
            where: {
              fieldFilter: {
                field: { fieldPath: 'createdAt' },
                op:    'LESS_THAN',
                value: { integerValue: vinte4h.toString() }
              }
            },
            limit: 50
          }
        })
      }
    );

    const data = await res.json();
    if (!Array.isArray(data)) return;

    for (const item of data) {
      if (!item.document) continue;
      const jobId  = item.document.name.split('/').pop();
      const fields = item.document.fields || {};

      // Deleta fotos do Storage
      for (let n = 1; n <= 6; n++) {
        if (fields[`photo_${n}`]?.stringValue) {
          const fileName = encodeURIComponent(`jobs/${jobId}/photo_${n}.jpg`);
          await fetch(
            `https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${fileName}`,
            {
              method:  'DELETE',
              headers: { 'Authorization': `Bearer ${accessToken}` }
            }
          ).catch(() => {});
        }
      }

      // Deleta imagem original do Storage
      const origFileName = encodeURIComponent(`jobs/${jobId}/original.jpg`);
      await fetch(
        `https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${origFileName}`,
        {
          method:  'DELETE',
          headers: { 'Authorization': `Bearer ${accessToken}` }
        }
      ).catch(() => {});

      // Deleta documento do Firestore
      await fetch(
        `https://firestore.googleapis.com/v1/projects/${process.env.FIREBASE_PROJECT_ID}/databases/(default)/documents/jobs/${jobId}`,
        {
          method:  'DELETE',
          headers: { 'Authorization': `Bearer ${accessToken}` }
        }
      ).catch(() => {});
    }

    console.log(`Limpeza: ${data.filter(i => i.document).length} jobs removidos`);
  } catch (e) {
    console.error('Erro na limpeza:', e.message);
  }
}

// ── Função Inngest: limpeza diária ───────────────────────
const limparStorage = inngest.createFunction(
  { id: 'limpar-storage', retries: 1 },
  { cron: '0 3 * * *' },
  async () => {
    const accessToken = await getServiceAccountToken();
    await limparJobsAntigos(accessToken);
  }
);

// ── Função Inngest: geração de fotos ─────────────────────
const gerarFotos = inngest.createFunction(
  { id: 'gerar-fotos', retries: 2, timeouts: { finish: '10m' } },
  { event: 'vitrio/gerar' },
  async ({ event, step }) => {
    // ── Recebe APENAS jobId ──────────────────────────────
    const { jobId } = event.data;
    if (!jobId) throw new Error('jobId não fornecido');

    const accessToken = await getServiceAccountToken();

    // ── Busca job completo no Firestore ──────────────────
    const jobDoc = await step.run('buscar-job', async () => {
      const doc    = await firestoreGet(accessToken, `jobs/${jobId}`);
      const fields = doc.fields || {};
      return {
        imageFilePath:  fields.imageFilePath?.stringValue,
        selectedPhotos: (fields.selectedPhotos?.arrayValue?.values || [])
                          .map(v => parseInt(v.integerValue)),
        prompts:        Object.fromEntries(
                          Object.entries(fields.prompts?.mapValue?.fields || {})
                            .map(([k, v]) => [k, v.stringValue])
                        )
      };
    });

    await updateJob(accessToken, jobId, { status: 'processing', updatedAt: Date.now() });

    // ── Baixa imagem original do Storage ─────────────────
    const imageBase64 = await step.run('baixar-imagem', async () => {
      return await downloadFromStorage(accessToken, jobDoc.imageFilePath);
    });

    // ── Análise técnica ──────────────────────────────────
    const analise = await step.run('analisar', async () => {
      try { return await analisarPeca(imageBase64); } catch { return {}; }
    });
    const descricao = montarDescricao(analise);

    const { selectedPhotos, prompts } = jobDoc;

// ── Foto 1 — usa existente ou gera nova ──────────────
await step.run('foto-1', async () => {
  const jobAtual = await firestoreGet(accessToken, `jobs/${jobId}`);
  const foto1Existe = jobAtual.fields?.photo_1?.stringValue;

  let b64;
  if (foto1Existe) {
    b64 = await downloadFromStorage(accessToken, `jobs/${jobId}/photo_1.jpg`);
  } else {
    b64 = await gerarFoto(prompts['1'], imageBase64, descricao);
    if (selectedPhotos.includes(1)) {
      const url = await salvarImagem(accessToken, jobId, 1, b64);
      await updateJob(accessToken, jobId, { 1: url, updatedAt: Date.now() });
    }
  }
  await updateJob(accessToken, jobId, { ref_path: `jobs/${jobId}/photo_1.jpg`, updatedAt: Date.now() });
});

// Busca path da foto 1 e baixa para usar como referência
const jobComRef = await firestoreGet(accessToken, `jobs/${jobId}`);
const refPath = jobComRef.fields?.photo_ref_path?.stringValue;
const ref = refPath ? await downloadFromStorage(accessToken, refPath) : imageBase64;
    if (selectedPhotos.includes(2)) {
      await step.run('foto-2', async () => {
        const b64 = await gerarFoto(prompts['2'], ref, descricao);
        const url = await salvarImagem(accessToken, jobId, 2, b64);
        await updateJob(accessToken, jobId, { 2: url, updatedAt: Date.now() });
      });
    }

    // ── Foto 3 (referência: Foto 1) ──────────────────────
    if (selectedPhotos.includes(3)) {
      await step.run('foto-3', async () => {
        const b64 = await gerarFoto(prompts['3'], ref, descricao);
        const url = await salvarImagem(accessToken, jobId, 3, b64);
        await updateJob(accessToken, jobId, { 3: url, updatedAt: Date.now() });
      });
    }

    // ── Foto 4 (referência: Foto 1) ──────────────────────
    if (selectedPhotos.includes(4)) {
      await step.run('foto-4', async () => {
        const b64 = await gerarFoto(prompts['4'], ref, descricao);
        const url = await salvarImagem(accessToken, jobId, 4, b64);
        await updateJob(accessToken, jobId, { 4: url, updatedAt: Date.now() });
      });
    }

    // ── Foto 5 (referência: Foto 1) ──────────────────────
    if (selectedPhotos.includes(5)) {
      await step.run('foto-5', async () => {
        const b64 = await gerarFoto(prompts['5'], ref, descricao);
        const url = await salvarImagem(accessToken, jobId, 5, b64);
        await updateJob(accessToken, jobId, { 5: url, updatedAt: Date.now() });
      });
    }

    // ── Foto 6 (referência: Foto 1) ──────────────────────
    if (selectedPhotos.includes(6)) {
      await step.run('foto-6', async () => {
        const b64 = await gerarFoto(prompts['6'], ref, descricao);
        const url = await salvarImagem(accessToken, jobId, 6, b64);
        await updateJob(accessToken, jobId, { 6: url, updatedAt: Date.now() });
      });
    }

    await updateJob(accessToken, jobId, { status: 'completed', updatedAt: Date.now() });
  }
);

module.exports = serve({
  client:    inngest,
  functions: [gerarFotos, limparStorage],
});
