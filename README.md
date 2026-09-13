# FilmeBOT 9000

Ferramenta web para envio de grades de programação de filmes em PDF, extração automática das informações por página e revisão antes do envio para o Trello.

## Visão geral

O app tem três fases:

1. **Envio** — tela compacta com apenas a área de upload (título, drop zone, formato aceito). Só aceita um arquivo PDF por vez.
2. **Processamento** — o PDF é dividido em páginas (a primeira e a última são ignoradas por padrão) e cada página é enviada para extração via webhook, com uma prévia visual (canvas) e barra de progresso.
3. **Revisão** — a programação extraída aparece agrupada por página na coluna de resultados, onde é possível conferir, corrigir e então enviar tudo para o Trello.

A janela cresce automaticamente da fase de envio para as demais assim que o processamento começa, e a coluna de resultados só existe (em termos de layout) a partir daí — antes disso ela fica fora do grid, sem afetar o tamanho do card.

## Principais funcionalidades

- **Seleção/drag & drop de um único PDF**, com validação de tamanho (50 MB).
- **Renderização de páginas no navegador** via PDF.js, com canvas de prévia e navegação página a página.
- **Envio de cada página para um workflow de extração** (n8n), com timeout e possibilidade de cancelar páginas pendentes.
- **Cancelamento e reenvio** de páginas individualmente.
- **Edição da programação extraída** antes de enviar para o Trello.
- **Envio final para o Trello** por um webhook separado do de processamento, com mensagem de estado (`save-state-message`).
- **Healthcheck** do workflow em segundo plano, com indicador na barra superior.
- **Gradiente de fundo interativo**, que acompanha o cursor.
- Título com efeito de máquina de escrever na tela inicial.

## Estrutura de arquivos

```
index.html    Estrutura da página (fases: upload / processamento / revisão)
styles.css    Estilos e responsividade
app.js        Lógica: leitura do PDF, fila de páginas, extração, revisão, envio ao Trello
favicon.png   Ícone da aba (não incluído neste pacote)
```

## Dependências externas

Carregadas via CDN (`cdnjs`), sem necessidade de build:

- **PDF.js** — renderização das páginas do PDF no `<canvas>`.
- **pdf-lib** — manipulação/leitura do PDF (separação de páginas).

## Configuração

Os parâmetros ficam no topo do `app.js`, no objeto `CONFIG`:

| Campo | Descrição |
|---|---|
| `PROCESS_WEBHOOK_URL` | Endpoint que recebe cada página para extração das informações. |
| `SAVE_WEBHOOK_URL` | Endpoint que recebe a programação revisada, para envio ao Trello. |
| `HEALTHCHECK_URL` | Endpoint de checagem de disponibilidade do workflow. |
| `FILE_FIELD_NAME` | Nome do campo enviado no multipart (padrão: `page`). |
| `SEND_INTERVAL_MS` | Intervalo entre o envio de páginas. |
| `PROCESS_TIMEOUT_MS` | Timeout por página durante a extração. |
| `SAVE_TIMEOUT_MS` | Timeout do envio final ao Trello. |
| `HEALTHCHECK_INTERVAL_MS` / `HEALTHCHECK_TIMEOUT_MS` | Frequência e timeout do healthcheck. |
| `MAX_FILE_SIZE_BYTES` | Limite de tamanho do PDF de origem. |

## Como usar localmente

1. Preencha `PROCESS_WEBHOOK_URL`, `SAVE_WEBHOOK_URL` e `HEALTHCHECK_URL` em `app.js`.
2. Sirva os arquivos por um servidor HTTP simples (ex.: `python3 -m http.server`) — como há `fetch` para APIs externas, evite abrir via `file://` diretamente (alguns navegadores bloqueiam requisições nesse contexto).
3. Abra no navegador e selecione um PDF para iniciar.

## Compatibilidade

Usa recursos modernos de CSS (Container Queries, `clamp()`, CSS Grid) e depende de PDF.js/pdf-lib para manipular PDFs no navegador. Recomendado Chrome, Edge, Firefox ou Safari em versões recentes (últimos ~2 anos).
