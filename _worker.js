export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/process") {
      return forwardToN8N(request, env.N8N_PROCESS_WEBHOOK_URL);
    }

    if (url.pathname === "/api/save") {
      return forwardToN8N(request, env.N8N_SAVE_WEBHOOK_URL);
    }

    if (url.pathname === "/api/healthcheck") {
      return forwardToN8N(
        request,
        env.N8N_HEALTHCHECK_URL
      );
    }

    return env.ASSETS.fetch(request);
  },
};

async function forwardToN8N(request, webhookUrl) {
  // Não mostra o valor do Secret.
  if (!webhookUrl) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "WEBHOOK_SECRET_AUSENTE",
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
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
      body: ["GET", "HEAD"].includes(request.method)
        ? undefined
        : request.body,
    });

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "ERRO_AO_ACESSAR_WEBHOOK",
        message: error instanceof Error
          ? error.message
          : String(error),
      }),
      {
        status: 502,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  }
}
