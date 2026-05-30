import { Inngest } from 'inngest';
import { serve } from 'inngest/next';

// ── CLIENTE INNGEST ──────────────────────────────────────
const inngest = new Inngest({
  id: 'vitrio-ai',
  eventKey: process.env.INNGEST_EVENT_KEY,
});

// ── FUNÇÕES AUXILIARES ───────────────────────────────────
async function analisarPeca(imageBase64) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
          { type: 'text', text: `Analise esta joia e retorne APENAS JSON técnico:
{
  "metal": "ouro|prata|rose_gold|desconhecido",
  "acabamento": "polido|fosco|escovado|texturizado",
  "pedras": true|false,
  "tipo_pedra": "cristal|zirconia|rubi|esmeralda|perola|sem_pedra",
  "quantidade_pedras": numero,
  "perolas": true|false,
  "quantidade_perolas": numero,
  "tipo_elo": "retangular|oval|redondo|figaro|veneziana|sem_elo",
  "espessura_elo": "fina|media|grossa",
  "fecho": "lagosta|mola|gaveta|toggle|sem_fecho",
  "pingente": true|false,
  "tipo_pingente": "coracao|cruz|letra|simbolo|sem_pingente",
  "gravacao": true|false,
  "detalhes_extras": "ate 15 palavras"
}` }
        ]
      }]
    })
  });
  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || '{}';
  try { return JSON.parse(text.replace(/```json|```/g, '').trim()); }
  catch { return {}; }
}

function montarDescricaoTecnica(analise) {
  const partes = [];
  if (analise.metal && analise.metal !== 'desconhecido') partes.push(`metal: ${analise.metal}`);
  if (analise.acabamento) partes.push(`acabamento ${analise.acabamento}`);
  if (analise.pedras && analise.tipo_pedra && analise.tipo_pedra !== 'sem_pedra') {
    const qtd = analise.quantidade_pedras > 0 ? `${analise.quantidade_pedras} ` : '';
    partes.push(`${qtd}pedra(s) ${analise.tipo_pedra}`);
  }
  if (analise.perolas && analise.quantidade_perolas > 0) partes.push(`${analise.quantidade_perolas} pérola(s)`);
  if (analise.tipo_elo && analise.tipo_elo !== 'sem_elo') partes.push(`elo ${analise.tipo_elo} ${analise.espessura_elo || ''}`);
  if (analise.fecho && analise.fecho !== 'sem_fecho') partes.push(`fecho ${analise.fecho}`);
  if (analise.pingente && analise.tipo_pingente !== 'sem_pingente') partes.push(`pingente ${analise.tipo_pingente}`);
  if (analise.gravacao) partes.push('com gravação');
  if (analise.detalhes_extras) partes.push(analise.detalhes_extras);
  return partes.length > 0 ? `\nCaracterísticas técnicas: ${partes.join(', ')}.` : '';
}

async function gerarFoto(prompt, imageBase64, descricaoTecnica = '', retries = 3) {
  const promptFinal = prompt + descricaoTecnica;
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      input: [{
        role: 'user',
        content: [
          { type: 'input_image', image_url: `data:image/png;base64,${imageBase64}` },
          { type: 'input_text', text: `Observe a joia na imagem. Reproduza EXATAMENTE este produto. Aplique: ${promptFinal}` }
        ]
      }],
      tools: [{ type: 'image_generation', size: '1024x1024' }]
    })
  });

  if (response.status === 429 && retries > 0) {
    await new Promise(r => setTimeout(r, 15000));
    return gerarFoto(prompt, imageBase64, descricaoTecnica, retries - 1);
  }

  if (!response.ok) throw new Error(`OpenAI ${response.status}`);
  const data = await response.json();
  const imageOutput = data.output?.find(o => o.type === 'image_generation_call');
  if (!imageOutput) throw new Error('Imagem não gerada');
  return imageOutput.result;
}

// ── FUNÇÃO INNGEST ───────────────────────────────────────
export const gerarFotos = inngest.createFunction(
  {
    id: 'gerar-fotos',
    retries: 2,
    timeouts: { finish: '10m' }
  },
  { event: 'vitrio/gerar' },
  async ({ event, step }) => {
    const { jobId, imageBase64, prompts, selectedPhotos, userId } = event.data;

    // Salva status inicial no Firebase via API
    await updateJobStatus(jobId, 'processing', {});

    // ETAPA 1 — Análise técnica
    const analise = await step.run('analisar-peca', async () => {
      try { return await analisarPeca(imageBase64); }
      catch { return {}; }
    });

    const descricao = montarDescricaoTecnica(analise);

    // ETAPA 2 — Gera Foto 1
    let photo1B64 = null;
    if (selectedPhotos.includes(1)) {
      photo1B64 = await step.run('gerar-foto-1', async () => {
        const b64 = await gerarFoto(prompts[1], imageBase64, descricao);
        await updateJobStatus(jobId, 'processing', { 1: b64 });
        return b64;
      });
    }

    // ETAPA 3 — Gera Foto 2 e 3 em paralelo usando foto 1 como base
    const refB64 = photo1B64 || imageBase64;

    if (selectedPhotos.includes(2)) {
      await step.run('gerar-foto-2', async () => {
        const b64 = await gerarFoto(prompts[2], refB64, descricao);
        await updateJobStatus(jobId, 'processing', { 2: b64 });
      });
    }

    if (selectedPhotos.includes(3)) {
      await step.run('gerar-foto-3', async () => {
        const b64 = await gerarFoto(prompts[3], refB64, descricao);
        await updateJobStatus(jobId, 'processing', { 3: b64 });
      });
    }

    await updateJobStatus(jobId, 'completed', {});
  }
);

// ── ATUALIZA STATUS NO FIREBASE ──────────────────────────
async function updateJobStatus(jobId, status, photos) {
  try {
    await fetch(`https://firestore.googleapis.com/v1/projects/${process.env.FIREBASE_PROJECT_ID}/databases/(default)/documents/jobs/${jobId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          status: { stringValue: status },
          updatedAt: { integerValue: Date.now().toString() },
          ...Object.entries(photos).reduce((acc, [num, b64]) => {
            acc[`photo_${num}`] = { stringValue: b64 };
            return acc;
          }, {})
        }
      })
    });
  } catch (e) {
    console.error('Erro ao atualizar job:', e.message);
  }
}

// ── HANDLER SERVE ────────────────────────────────────────
export default serve({
  client: inngest,
  functions: [gerarFotos],
  signingKey: process.env.INNGEST_SIGNING_KEY,
});
