// api/status.js
// Consulta o status de um job no Firestore

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido' });

  const { jobId } = req.query;
  if (!jobId) return res.status(400).json({ error: 'jobId obrigatório' });

  try {
    const response = await fetch(
      `https://firestore.googleapis.com/v1/projects/${process.env.FIREBASE_PROJECT_ID}/databases/(default)/documents/jobs/${jobId}`,
      { headers: { 'Content-Type': 'application/json' } }
    );

    if (!response.ok) return res.status(404).json({ error: 'Job não encontrado' });

    const data = await response.json();
    const fields = data.fields || {};

    // Monta resposta com status e fotos disponíveis
    const result = {
      jobId,
      status: fields.status?.stringValue || 'pending',
      photos: {}
    };

    // Verifica cada foto
    [1, 2, 3].forEach(n => {
      if (fields[`photo_${n}`]?.stringValue) {
        result.photos[n] = fields[`photo_${n}`].stringValue;
      }
    });

    return res.status(200).json(result);

  } catch (e) {
    console.error('Erro ao consultar status:', e.message);
    return res.status(500).json({ error: 'Erro ao consultar status' });
  }
}
