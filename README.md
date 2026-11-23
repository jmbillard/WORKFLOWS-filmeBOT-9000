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
- **Scanner de 2 passadas + loader**: ao enviar uma página, o feixe do scanner passa duas vezes sobre ela e em seguida é exibido um loader simples até o retorno do workflow.
- **Envio de imagens junto com cada página**: a página completa em JPEG e os posters de cada filme recortados em ordem de leitura (veja abaixo).
- **Pôster de cada filme**: o recorte que fica logo acima do título do filme na página vira o pôster dele (se não achar o título e a página tiver um pôster por filme, vai pela ordem). A miniatura aparece no card; clicar nela abre os pôsteres da página para trocar, ou basta clicar no pôster no preview. No hover do card, o pôster dele acende no preview.
- **Grade igual à página**: os cards seguem a ordem dos pôsteres da página e, no lugar de um pôster sem filme (cancelado ou fora da agenda, que a extração ignora), entra um card fantasma com o pôster apagado e o texto que está embaixo dele. "incluir" transforma o fantasma em filme, com título, ano e pôster.
- **Conferência antes do envio** (`CHECK_ON_SAVE_WEBHOOK`, pelo mesmo webhook do envio): cada filme mostra o que o envio vai fazer — no acervo / filme novo, ano diferente do acervo (com "usar" para corrigir), sessão sem cadastro, card que já existe no dia (não é duplicado) e quantas artes são novas e quantas já existem. O topo resume: cards novos, já existentes e filmes novos.
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

## Webhooks escondidos (worker)

O site chama `/api/process`, `/api/save` e `/api/healthcheck`; o `_worker.js` repassa para o n8n. As URLs dos webhooks ficam só nos segredos do worker na Cloudflare (`N8N_PROCESS_WEBHOOK_URL`, `N8N_SAVE_WEBHOOK_URL`, `N8N_HEALTHCHECK_URL`), nunca no repositório nem no site. Para publicar: `npx wrangler deploy` (o `wrangler.jsonc` aponta para o worker `fimebot-9000`).

## Revisão

Os cards ficam em cima, na mesma grade da página (as colunas da fileira com mais pôsteres), e o preview embaixo. A Sessão da Tarde aparece também num bloco próprio no topo, com todos os títulos do PDF: é o que vira o card resumo no Trello (títulos a produzir no checklist, os que já existem só na descrição).

## Configuração

Os parâmetros ficam no topo do `app.js`, no objeto `CONFIG`:

| Campo | Descrição |
|---|---|
| `PROCESS_WEBHOOK_URL` | Endpoint que recebe cada página para extração das informações. |
| `SAVE_WEBHOOK_URL` | Endpoint que recebe a programação revisada, para envio ao Trello. |
| `CHECK_ON_SAVE_WEBHOOK` | Liga a conferência: manda `{ acao: "conferir", movies }` ao `SAVE_WEBHOOK_URL`, que só lê e devolve `{ movies: [{ ord, novo, filme_titulo, ano, ano_diferente, sessao_ok, card_existente, artes_novas, artes_existentes }] }`. Ligar junto com o fluxo de cards v10. |
| `HEALTHCHECK_URL` | Endpoint de checagem de disponibilidade do workflow. |
| `FILE_FIELD_NAME` | Nome do campo enviado no multipart (padrão: `page`). |
| `SEND_INTERVAL_MS` | Intervalo entre o envio de páginas. |
| `PROCESS_TIMEOUT_MS` | Timeout por página durante a extração. |
| `SAVE_TIMEOUT_MS` | Timeout do envio final ao Trello. |
| `HEALTHCHECK_INTERVAL_MS` / `HEALTHCHECK_TIMEOUT_MS` | Frequência e timeout do healthcheck. |
| `MAX_FILE_SIZE_BYTES` | Limite de tamanho do PDF de origem. |

## Campos enviados ao webhook de processamento

Cada página é enviada como `multipart/form-data` com:

| Campo | Conteúdo |
|---|---|
| `page` | PDF da página (nome configurável em `FILE_FIELD_NAME`). |
| `page_image` | JPEG da página completa (renderizada em 2x). |
| `poster_1` … `poster_N` | JPEG de cada poster, em ordem de leitura: linhas de cima para baixo e, em cada linha, da esquerda para a direita. |
| `poster_count` | Quantidade de posters enviados. |
| `poster_boxes` | JSON com `{x, y, width, height}` de cada poster, em pixels da `page_image`. |
| `request_id`, `document_id`, `original_file_name`, `original_page_number`, `useful_page_number`, `total_useful_pages` | Metadados da página. |

No n8n, cada arquivo chega como uma propriedade binária com o mesmo nome do campo (`poster_1`, `poster_2`, …).

Os posters são localizados pelas posições em que as imagens são desenhadas no PDF (via PDF.js) e recortados da página renderizada. Imagens de fundo, logos e ícones são descartados por uma heurística de tamanho e proporção, ajustável em `CONFIG` (`POSTER_MIN_WIDTH_RATIO`, `POSTER_MIN_HEIGHT_RATIO`, `POSTER_MAX_AREA_RATIO`, `POSTER_MIN_ASPECT`, `POSTER_MAX_ASPECT`). Se a extração das imagens falhar, a página é enviada mesmo assim, com `poster_count = 0`.

## Pôster no envio

Cada filme vai no envio com `poster`: o JPEG em data URL (até `POSTER_SEND_MAX_HEIGHT` px de altura), ou vazio quando o filme ficou sem pôster. O fluxo de cards guarda o pôster no cadastro do filme quando ele ainda não tem (não vai para o card).

## Como usar localmente

1. Preencha `PROCESS_WEBHOOK_URL`, `SAVE_WEBHOOK_URL` e `HEALTHCHECK_URL` em `app.js`.
2. Sirva os arquivos por um servidor HTTP simples (ex.: `python3 -m http.server`) — como há `fetch` para APIs externas, evite abrir via `file://` diretamente (alguns navegadores bloqueiam requisições nesse contexto).
3. Abra no navegador e selecione um PDF para iniciar.

## Compatibilidade

Usa recursos modernos de CSS (Container Queries, `clamp()`, CSS Grid) e depende de PDF.js/pdf-lib para manipular PDFs no navegador. Recomendado Chrome, Edge, Firefox ou Safari em versões recentes (últimos ~2 anos).
