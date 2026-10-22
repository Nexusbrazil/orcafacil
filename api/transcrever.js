// /api/transcrever.js
// POST multipart/form-data → Gemini Flash multimodal autenticado com GEMINI_API_KEY.

export const config = {
  api: {
    bodyParser: false,
  },
};

const GEMINI_MODEL = 'gemini-3.8-flash';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const CAMPOS_ARQUIVO = new Set(['file', 'audio', 'audio_file', 'arquivo', 'recording', 'uploaded_file']);

function aplicarCors(req, res) {
  const requested = req.headers?.['access-control-request-headers'];
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    requested || 'Content-Type, Authorization, Accept, X-Requested-With, Origin',
  );
  res.setHeader('Access-Control-Max-Age', '86400');
}

function json(req, res, status, payload) {
  aplicarCors(req, res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (typeof res.status === 'function' && typeof res.json === 'function') {
    return res.status(status).json(payload);
  }
  res.statusCode = status;
  res.end(JSON.stringify(payload));
}

function lerGeminiKey() {
  return String(process.env.GEMINI_API_KEY || '').trim();
}

function erroChaveAusente() {
  return {
    erro: 'GEMINI_API_KEY não configurada no servidor.',
    dica: 'Em Vercel → Project → Settings → Environment Variables, crie GEMINI_API_KEY e faça um novo deploy.',
  };
}

function serializarErro(erro) {
  const cause = erro?.cause;
  return {
    message: erro?.message || String(erro),
    name: erro?.name,
    code: erro?.code || cause?.code,
    cause: cause
      ? {
          message: cause.message || String(cause),
          name: cause.name,
          code: cause.code,
          syscall: cause.syscall,
          hostname: cause.hostname,
        }
      : undefined,
  };
}

function urlGemini(apiKey) {
  return `${GEMINI_BASE}/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
}

function mimeGemini(mimeType, filename = '') {
  const nome = String(filename).toLowerCase();
  const mime = String(mimeType || '').toLowerCase();

  if (mime.includes('wav') || nome.endsWith('.wav')) return 'audio/wav';
  if (mime.includes('mpeg') || mime.includes('mp3') || nome.endsWith('.mp3')) return 'audio/mp3';
  if (mime.includes('m4a') || nome.endsWith('.m4a')) return 'audio/mp4';
  if (mime.includes('mp4') || nome.endsWith('.mp4')) return 'audio/mp4';
  if (mime.includes('ogg') || nome.endsWith('.ogg')) return 'audio/ogg';
  if (mime.includes('flac') || nome.endsWith('.flac')) return 'audio/flac';
  if (mime.includes('aac') || nome.endsWith('.aac')) return 'audio/aac';
  if (mime.includes('webm') || nome.endsWith('.webm')) return 'audio/webm';
  if (mime.startsWith('audio/')) return mime;
  return 'audio/webm';
}

function lerBuffer(req, maxBytes) {
  if (Buffer.isBuffer(req.body)) {
    if (req.body.length > maxBytes) {
      const erro = new Error('AUDIO_TOO_LARGE');
      erro.status = 413;
      return Promise.reject(erro);
    }
    return Promise.resolve(req.body);
  }

  if (typeof req.body === 'string') {
    const buf = Buffer.from(req.body);
    if (buf.length > maxBytes) {
      const erro = new Error('AUDIO_TOO_LARGE');
      erro.status = 413;
      return Promise.reject(erro);
    }
    return Promise.resolve(buf);
  }

  if (req.readableEnded) return Promise.resolve(Buffer.alloc(0));

  return new Promise((resolve, reject) => {
    const chunks = [];
    let tamanho = 0;
    const timer = setTimeout(() => reject(new Error('TIMEOUT_BODY')), 15_000);

    req.on('data', (chunk) => {
      tamanho += chunk.length;
      if (tamanho > maxBytes) {
        clearTimeout(timer);
        const erro = new Error('AUDIO_TOO_LARGE');
        erro.status = 413;
        reject(erro);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (erro) => {
      clearTimeout(timer);
      reject(erro);
    });
  });
}

function parseMultipart(buffer, contentType) {
  const match = /boundary\s*=\s*(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!match) return { fields: {}, files: [] };

  const boundary = (match[1] || match[2]).trim();
  const delim = Buffer.from(`\r\n--${boundary}`);
  const prefix = Buffer.from(`--${boundary}`);
  const fields = {};
  const files = [];

  let cursor = buffer.indexOf(prefix);
  if (cursor < 0) return { fields, files };
  cursor += prefix.length;
  if (buffer[cursor] === 13 && buffer[cursor + 1] === 10) cursor += 2;

  while (cursor < buffer.length) {
    if (buffer[cursor] === 45 && buffer[cursor + 1] === 45) break;

    const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), cursor);
    if (headerEnd < 0) break;

    const headers = buffer.slice(cursor, headerEnd).toString('utf8');
    const next = buffer.indexOf(delim, headerEnd + 4);
    if (next < 0) break;

    const body = buffer.slice(headerEnd + 4, next);
    const nameMatch = /name="([^"]+)"/i.exec(headers);
    const filenameMatch = /filename\*?=(?:UTF-8''|")?([^";\r\n]*)/i.exec(headers);
    const typeMatch = /content-type:\s*([^\r\n]+)/i.exec(headers);
    const name = nameMatch ? nameMatch[1] : '';
    const filename = filenameMatch ? decodeURIComponent(filenameMatch[1].replace(/"/g, '')) : '';
    const mimeType = typeMatch ? typeMatch[1].trim() : '';
    const pareceArquivo = Boolean(filenameMatch) || CAMPOS_ARQUIVO.has(name) || mimeType.startsWith('audio/');

    if (pareceArquivo && body.length) {
      files.push({
        fieldName: name,
        filename: filename || 'audio.webm',
        mimeType: mimeType || 'application/octet-stream',
        buffer: body,
      });
    } else if (name) {
      fields[name] = body.toString('utf8');
    }

    cursor = next + delim.length;
    if (buffer[cursor] === 13 && buffer[cursor + 1] === 10) cursor += 2;
  }

  return { fields, files };
}

function escolherArquivo(files, fields) {
  const direto = files.find((f) => CAMPOS_ARQUIVO.has(f.fieldName)) || files[0];
  if (direto?.buffer?.length) return direto;

  const base64 =
    fields.audio_base64 ||
    fields.audioBase64 ||
    fields.file_base64 ||
    fields.base64;

  if (base64) {
    const limpo = String(base64).replace(/^data:[^;]+;base64,/, '');
    return {
      fieldName: 'file',
      filename: fields.filename || 'audio.webm',
      mimeType: fields.mime_type || fields.mimeType || 'audio/webm',
      buffer: Buffer.from(limpo, 'base64'),
    };
  }

  return null;
}

function audioDeJson(body) {
  if (!body || typeof body !== 'object') return null;

  const base64 = body.audio_base64 || body.audioBase64 || body.file_base64 || body.base64 || body.audio;
  if (typeof base64 !== 'string' || !base64.trim()) return null;
  if (base64.startsWith('http')) return null;

  const limpo = base64.replace(/^data:[^;]+;base64,/, '');
  return {
    filename: body.filename || 'audio.webm',
    mimeType: body.mime_type || body.mimeType || 'audio/webm',
    buffer: Buffer.from(limpo, 'base64'),
  };
}

async function transcreverComGemini(audio, apiKey) {
  const url = urlGemini(apiKey);
  let resposta;

  try {
    resposta = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'OrçaFácil-AI/1.0',
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: 'Transcreva este áudio em português brasileiro. Devolva APENAS o texto falado, sem aspas, sem markdown e sem comentários.',
              },
              {
                inlineData: {
                  mimeType: mimeGemini(audio.mimeType, audio.filename),
                  data: audio.buffer.toString('base64'),
                },
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 2048,
        },
      }),
      signal: AbortSignal.timeout(Number(process.env.GEMINI_TIMEOUT_MS || 50000)),
    });
  } catch (erroFetch) {
    const falha = new Error(erroFetch.message || 'fetch failed');
    falha.cause = erroFetch.cause || erroFetch;
    falha.code = erroFetch.code || erroFetch.cause?.code;
    throw falha;
  }

  const bruto = await resposta.text();
  let parsed = {};
  try {
    parsed = bruto ? JSON.parse(bruto) : {};
  } catch {
    parsed = { raw: bruto };
  }

  if (!resposta.ok) {
    const erro = new Error(parsed.error?.message || `Gemini HTTP ${resposta.status}`);
    erro.status = resposta.status;
    throw erro;
  }

  const parts = parsed?.candidates?.[0]?.content?.parts || [];
  const texto = parts.map((part) => part.text || '').join('').trim();
  const bloqueio = parsed?.promptFeedback?.blockReason || parsed?.candidates?.[0]?.finishReason;

  if (!texto) {
    const erro = new Error(bloqueio ? `Resposta bloqueada: ${bloqueio}` : 'Transcrição vazia.');
    erro.status = 422;
    throw erro;
  }

  return texto.replace(/^["']|["']$/g, '').trim();
}

export default async function handler(req, res) {
  try {
    aplicarCors(req, res);

    if (req.method === 'OPTIONS') {
      res.statusCode = 200;
      return res.end();
    }

    const apiKey = lerGeminiKey();
    const maxAudioBytes = Number(process.env.MAX_AUDIO_BYTES || 4.5 * 1024 * 1024);

    if (req.method === 'GET') {
      return json(req, res, apiKey ? 200 : 500, {
        ok: Boolean(apiKey),
        servico: 'transcrever',
        provedor: 'gemini',
        modelo: GEMINI_MODEL,
        gemini_configurada: Boolean(apiKey),
        metodo: 'POST multipart/form-data no campo "file" (ou "audio")',
        ...(apiKey ? {} : erroChaveAusente()),
      });
    }

    if (req.method !== 'POST') {
      return json(req, res, 405, { erro: 'Método não permitido. Use POST.' });
    }

    if (!apiKey) {
      return json(req, res, 500, erroChaveAusente());
    }

    const contentType = String(req.headers['content-type'] || '');
    let audio = null;

    if (contentType.includes('multipart/form-data')) {
      const bruto = await lerBuffer(req, maxAudioBytes);
      const parsed = parseMultipart(bruto, contentType);
      audio = escolherArquivo(parsed.files, parsed.fields);
    } else if (contentType.includes('application/json')) {
      let body = req.body;
      if (typeof body === 'string') body = JSON.parse(body);
      if (!body || Buffer.isBuffer(body) || typeof body !== 'object') {
        const bruto = await lerBuffer(req, maxAudioBytes);
        body = bruto.length ? JSON.parse(bruto.toString('utf8')) : {};
      }
      audio = audioDeJson(body);
    } else if (contentType.startsWith('audio/') || contentType === 'application/octet-stream') {
      const buffer = await lerBuffer(req, maxAudioBytes);
      audio = { filename: 'audio', mimeType: contentType, buffer };
    }

    if (!audio?.buffer?.length) {
      return json(req, res, 400, {
        erro: 'Envie o áudio em multipart/form-data no campo "file" (ou "audio").',
      });
    }

    if (audio.buffer.length > maxAudioBytes) {
      return json(req, res, 413, {
        erro: `Áudio acima do limite de ${Math.round(maxAudioBytes / (1024 * 1024))}MB da Vercel.`,
      });
    }

    const texto = await transcreverComGemini(audio, apiKey);
    return json(req, res, 200, { texto });
  } catch (erro) {
    if (erro.status === 413 || erro.message === 'AUDIO_TOO_LARGE') {
      return json(req, res, 413, {
        erro: 'Áudio acima do limite permitido pela Vercel (~4.5MB no plano Hobby).',
      });
    }

    console.error('[transcrever] Erro:', serializarErro(erro));
    return json(req, res, erro.status && erro.status < 500 ? erro.status : 502, {
      erro: 'Falha ao transcrever o áudio.',
      detalhe: serializarErro(erro),
    });
  }
}
