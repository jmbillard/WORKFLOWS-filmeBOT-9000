export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // PROCESS
    if (url.pathname === "/api/process") {
      return forwardToN8N(request, env.N8N_PROCESS_WEBHOOK_URL);
    }

    // SAVE
    if (url.pathname === "/api/save") {
      return forwardToN8N(request, env.N8N_SAVE_WEBHOOK_URL);
    }

    // HEALTHCHECK
    if (url.pathname === "/api/healthcheck") {
      return forwardToN8N(request, env.N8N_HEALTHCHECK_URL);
    }

    // Todo o resto continua sendo servido como arquivo estático
    return env.ASSETS.fetch(request);
  },
};

async function forwardToN8N(request, webhookUrl) {
  if (!webhookUrl) {
    return new Response("Webhook não configurado", {
      status: 500,
    });
  }

  const headers = new Headers(request.headers);

  // Não precisamos encaminhar esses headers para o n8n.
  headers.delete("host");
  headers.delete("content-length");

  const response = await fetch(webhookUrl, {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method)
      ? undefined
      : request.body,
  });

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
