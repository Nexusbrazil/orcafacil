// /api/orcamento.js
// POST JSON → Omniroute (chat) autenticado com OMNIROUTE_API_KEY.

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

function lerOmnirouteKey() {
  return String(process.env.OMNIROUTE_API_KEY || '').trim();
}

function resolverUrlChat() {
  const bruto = String(process.env.OMNIROUTE_URL || 'https://cloud.omniroute.online')
    .trim()
    .replace(/\/$/, '');

  if (/\/chat\/completions$/i.test(bruto)) return bruto;
  if (/\/v1$/i.test(bruto)) return `${bruto}/chat/completions`;
  return `${bruto}/v1/chat/completions`;
}

function serializarErro(erro) {
  const cause = erro?.cause;
  const causa = cause
    ? {
        message: cause.message || String(cause),
        name: cause.name,
        code: cause.code,
        errno: cause.errno,
        syscall: cause.syscall,
        hostname: cause.hostname,
        address: cause.address,
        port: cause.port,
      }
    : undefined;

  return {
    message: erro?.message || String(erro),
    name: erro?.name,
    code: erro?.code || cause?.code,
    cause: causa,
    url: erro?.url,
    modelo: erro?.modelo,
  };
}

function erroChaveAusente() {
  return {
    erro: 'OMNIROUTE_API_KEY não configurada no servidor.',
    dica: 'Em Vercel → Project → Settings → Environment Variables, crie OMNIROUTE_API_KEY e faça um novo deploy.',
  };
}

function lerBuffer(req) {
  if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
  if (typeof req.body === 'string') return Promise.resolve(Buffer.from(req.body));
  if (req.readableEnded) return Promise.resolve(Buffer.alloc(0));

  return new Promise((resolve, reject) => {
    const chunks = [];
    const timer = setTimeout(() => reject(new Error('TIMEOUT_BODY')), 10_000);
    req.on('data', (chunk) => chunks.push(chunk));
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

async function lerJson(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body;
  }

  const bruto = Buffer.isBuffer(req.body) || typeof req.body === 'string'
    ? (Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body))
    : await lerBuffer(req);

  if (!bruto.length) return {};
  return JSON.parse(bruto.toString('utf8'));
}

function paraNumero(valor) {
  if (typeof valor === 'number' && Number.isFinite(valor)) return valor;
  if (typeof valor !== 'string') return 0;
  const limpo = valor
    .replace(/[R$\s]/g, '')
    .replace(/\.(?=\d{3}(?:\D|$))/g, '')
    .replace(',', '.');
  const n = Number(limpo);
  return Number.isFinite(n) ? n : 0;
}

function paraLista(valor) {
  if (Array.isArray(valor)) return valor.map((item) => String(item).trim()).filter(Boolean);
  if (typeof valor === 'string' && valor.trim()) {
    return valor.split(/[;\n,]/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function normalizarHistorico(historico, maxItens) {
  let lista = historico;

  if (typeof lista === 'string') {
    try {
      lista = JSON.parse(lista);
    } catch {
      return [];
    }
  }

  if (!Array.isArray(lista)) return [];

  return lista
    .filter((item) => item && typeof item === 'object')
    .map((item) => {
      const role = item.role === 'assistant' || item.role === 'system' ? item.role : 'user';
      const content = String(item.content ?? item.mensagem ?? item.text ?? item.texto ?? '').trim();
      return { role, content };
    })
    .filter((item) => item.content && item.role !== 'system')
    .slice(-maxItens);
}

function montarPrompt(profissao, fluxo) {
  const oficio = profissao || 'profissionais autônomos';

  return `Você é um assistente especializado em elaborar orçamentos profissionais para ${oficio} no Brasil.
Seu único trabalho é coletar as informações necessárias e, quando tiver tudo, gerar um orçamento completo.

REGRAS ABSOLUTAS:
1. Responda SEMPRE e EXCLUSIVAMENTE com um objeto JSON válido. Nenhum texto fora do JSON.
2. Não use markdown, não use blocos de código, não adicione explicações.
3. O JSON deve seguir EXATAMENTE este schema:

{
  "status": "incompleto" | "completo",
  "perguntas_feedback": "Suas perguntas para coletar mais dados OU feedback após completar",
  "orcamento": {
    "cliente": "Nome do cliente ou 'A definir'",
    "servico_descricao": "Descrição detalhada do serviço",
    "mao_de_obra_valor": 0.0,
    "materiais_inclusos": ["item1", "item2"],
    "valor_total": 0.0,
    "prazo_entrega": "Ex: 5 dias úteis",
    "garantia": "Ex: 90 dias para defeitos de execução",
    "condicoes_pagamento": "Ex: 50% entrada, 50% na entrega"
  }
}

4. Quando status = "incompleto": preencha "perguntas_feedback" com perguntas claras e objetivas para obter os dados que faltam. O objeto "orcamento" pode ter campos vazios/zerados.
5. Quando status = "completo": preencha TODOS os campos do "orcamento" com valores reais. "mao_de_obra_valor" e "valor_total" devem ser números (float), nunca strings.
6. Para calcular valores, use preços médios de mercado brasileiro para ${oficio} em 2025/2026.
7. Fluxo atual da conversa: ${fluxo || 'coleta_inicial'}
8. Se faltar nome do cliente, descrição do serviço ou qualquer base para precificar, mantenha status = "incompleto".`;
}

function normalizarResposta(parsed) {
  const bruto = parsed && typeof parsed === 'object' ? parsed : {};
  const orcamento = bruto.orcamento && typeof bruto.orcamento === 'object' ? bruto.orcamento : {};
  const status = bruto.status === 'completo' ? 'completo' : 'incompleto';

  return {
    status,
    perguntas_feedback: String(bruto.perguntas_feedback ?? bruto.perguntas ?? '').trim(),
    orcamento: {
      cliente: String(orcamento.cliente || 'A definir').trim() || 'A definir',
      servico_descricao: String(orcamento.servico_descricao || '').trim(),
      mao_de_obra_valor: paraNumero(orcamento.mao_de_obra_valor),
      materiais_inclusos: paraLista(orcamento.materiais_inclusos),
      valor_total: paraNumero(orcamento.valor_total),
      prazo_entrega: String(orcamento.prazo_entrega || '').trim(),
      garantia: String(orcamento.garantia || '').trim(),
      condicoes_pagamento: String(orcamento.condicoes_pagamento || '').trim(),
    },
  };
}

function extrairJson(conteudoRaw) {
  const limpo = String(conteudoRaw || '')
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  try {
    return JSON.parse(limpo);
  } catch {
    const inicio = limpo.indexOf('{');
    const fim = limpo.lastIndexOf('}');
    if (inicio >= 0 && fim > inicio) {
      return JSON.parse(limpo.slice(inicio, fim + 1));
    }
    throw new Error('JSON inválido retornado pela IA.');
  }
}

async function chamarModelo(modelo, mensagens, apiKey) {
  const url = resolverUrlChat();
  const apiKeyTrim = String(process.env.OMNIROUTE_API_KEY || apiKey || '').trim();

  let resposta;
  try {
    resposta = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKeyTrim}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Node-Fetch',
      },
      body: JSON.stringify({
        model: modelo,
        messages: mensagens,
        temperature: 0.3,
        max_tokens: 1500,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(Number(process.env.ORCAMENTO_TIMEOUT_MS || 45000)),
    });
  } catch (erroFetch) {
    const falha = new Error(erroFetch.message || 'fetch failed');
    falha.name = erroFetch.name || 'FetchError';
    falha.cause = erroFetch.cause || erroFetch;
    falha.code = erroFetch.code || erroFetch.cause?.code;
    falha.url = url;
    falha.modelo = modelo;
    throw falha;
  }

  const bruto = await resposta.text();
  let parsed = {};
  try {
    parsed = bruto ? JSON.parse(bruto) : {};
  } catch {
    parsed = {};
  }

  if (!resposta.ok) {
    const falha = new Error(parsed.error?.message || `Status ${resposta.status}: ${bruto.slice(0, 300)}`);
    falha.url = url;
    falha.modelo = modelo;
    throw falha;
  }

  const conteudo = parsed?.choices?.[0]?.message?.content;
  if (!conteudo) {
    const falha = new Error('Resposta vazia da IA.');
    falha.url = url;
    falha.modelo = modelo;
    throw falha;
  }

  return extrairJson(conteudo);
}

export default async function handler(req, res) {
  try {
    aplicarCors(req, res);

    if (req.method === 'OPTIONS') {
      res.statusCode = 200;
      return res.end();
    }

    const apiKey = lerOmnirouteKey();

    if (req.method === 'GET') {
      return json(req, res, apiKey ? 200 : 500, {
        ok: Boolean(apiKey),
        servico: 'orcamento',
        omniroute_configurada: Boolean(apiKey),
        url_chat: resolverUrlChat(),
        metodo: 'POST JSON { mensagem, profissao, historico, fluxo? }',
        ...(apiKey ? {} : erroChaveAusente()),
      });
    }

    if (req.method !== 'POST') {
      return json(req, res, 405, { erro: 'Método não permitido. Use POST.' });
    }

    if (!apiKey) {
      return json(req, res, 500, erroChaveAusente());
    }

    let body;
    try {
      body = await lerJson(req);
    } catch {
      return json(req, res, 400, { erro: 'JSON inválido no corpo da requisição.' });
    }

    const profissao = String(body.profissao || body.profession || '').trim();
    const fluxo = String(body.fluxo || body.flow || 'coleta_inicial').trim();
    const mensagem = String(body.mensagem || body.message || body.texto || body.transcricao || '').trim();
    const maxMensagem = 8000;

    if (!mensagem) {
      return json(req, res, 400, { erro: 'O campo "mensagem" é obrigatório.' });
    }

    if (mensagem.length > maxMensagem) {
      return json(req, res, 400, { erro: `A mensagem excede ${maxMensagem} caracteres.` });
    }

    const modelos = [...new Set([
      process.env.ORCAMENTO_MODEL_PRIMARY || 'deepseek-chat',
      process.env.ORCAMENTO_MODEL_FALLBACK || 'gemini-1.5-flash',
    ].filter(Boolean))];

    const mensagens = [
      { role: 'system', content: montarPrompt(profissao, fluxo) },
      ...normalizarHistorico(body.historico, 20),
      { role: 'user', content: mensagem },
    ];

    let ultimoErro = null;

    for (const modelo of modelos) {
      try {
        const parsed = await chamarModelo(modelo, mensagens, apiKey);
        const normalizado = normalizarResposta(parsed);

        if (!normalizado.perguntas_feedback && !normalizado.orcamento.servico_descricao) {
          return json(req, res, 422, { erro: 'A IA retornou JSON com estrutura insuficiente.' });
        }

        return json(req, res, 200, normalizado);
      } catch (erro) {
        ultimoErro = erro;
        console.warn(`[orcamento] Falha no modelo ${modelo}:`, serializarErro(erro));
      }
    }

    console.error('[orcamento] Todos os modelos falharam:', serializarErro(ultimoErro));
    return json(req, res, 502, {
      erro: 'Não foi possível gerar o orçamento no momento.',
      detalhe: serializarErro(ultimoErro),
    });
  } catch (erro) {
    console.error('[orcamento] Erro inesperado:', serializarErro(erro));
    return json(req, res, 500, {
      erro: 'Erro interno ao gerar o orçamento.',
      detalhe: serializarErro(erro),
    });
  }
}
