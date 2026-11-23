// FilmeBOT 9000: serve os arquivos e repassa /api/* para o n8n.
// As URLs dos webhooks ficam só nos segredos do worker (nunca no site):
//   N8N_PROCESS_WEBHOOK_URL, N8N_SAVE_WEBHOOK_URL, N8N_HEALTHCHECK_URL
const ROTAS = {
  "/api/process": "N8N_PROCESS_WEBHOOK_URL",
  "/api/save": "N8N_SAVE_WEBHOOK_URL",
  "/api/healthcheck": "N8N_HEALTHCHECK_URL",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // diagnóstico: quais segredos existem (só sim/não, nunca o valor)
    if (url.pathname === "/api/status") {
      return json(200, {
        worker: true,
        segredos: Object.fromEntries(Object.values(ROTAS).map(nome => [nome, Boolean(env[nome])])),
      });
    }

    const segredo = ROTAS[url.pathname];
    if (segredo) return forwardToN8N(request, env[segredo], segredo);

    return env.ASSETS.fetch(request);
  },
};

function json(status, body, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "x-filmebot-worker": "1", ...extra },
  });
}

async function forwardToN8N(request, webhookUrl, segredo) {
  // Não mostra o valor do segredo.
  if (!webhookUrl) {
    return json(500, { ok: false, error: "WEBHOOK_SECRET_AUSENTE", message: `Falta o segredo ${segredo} no worker.` });
  }

  try {
    const headers = new Headers(request.headers);

    // Esses headers não devem ser repassados.
    headers.delete("host");
    headers.delete("content-length");

    // Também vamos evitar que o n8n receba a origem do navegador.
    headers.delete("origin");
    headers.delete("referer");

    const response = await fetch(webhookUrl, {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
    });

    const out = new Headers(response.headers);
    out.set("x-filmebot-worker", "1");
    out.set("x-filmebot-origem", "n8n");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: out });
  } catch (error) {
    return json(502, {
      ok: false,
      error: "ERRO_AO_ACESSAR_WEBHOOK",
      message: `O worker não conseguiu falar com o n8n: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}
