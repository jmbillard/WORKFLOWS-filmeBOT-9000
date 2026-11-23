"use strict";

if (!window.pdfjsLib) throw new Error("PDF.js não foi carregado.");
if (!window.PDFLib) throw new Error("pdf-lib não foi carregada.");

const pdfjsLib = window.pdfjsLib;
const PDFLib = window.PDFLib;
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const CONFIG = Object.freeze({
  // O worker (_worker.js) repassa /api/* para o n8n: as URLs dos webhooks ficam
  // só nos segredos do worker, nunca no site.
  PROCESS_WEBHOOK_URL: "/api/process",
  SAVE_WEBHOOK_URL: "/api/save",
  // Conferência antes do envio (só leitura), pelo mesmo webhook do envio com
  // { acao: "conferir" }: para cada filme, o que o envio vai fazer — filme do
  // acervo ou novo, ano, sessão, card que já existe e artes que já existem.
  // desligada: a conferência das artes é feita pelo PROMeiro quando a claquete entra
  CHECK_ON_SAVE_WEBHOOK: false,
  CHECK_DEBOUNCE_MS: 700,
  CHECK_TIMEOUT_MS: 15000,
  HEALTHCHECK_URL: "/api/healthcheck",
  FILE_FIELD_NAME: "page",
  SEND_INTERVAL_MS: 2500,
  PROCESS_TIMEOUT_MS: 240000,
  SAVE_TIMEOUT_MS: 60000,
  HEALTHCHECK_INTERVAL_MS: 30000,
  HEALTHCHECK_TIMEOUT_MS: 5000,
  MAX_FILE_SIZE_BYTES: 50 * 1024 * 1024,
  // Imagens enviadas junto com cada página.
  PAGE_IMAGE_FIELD_NAME: "page_image",
  POSTER_FIELD_PREFIX: "poster_",
  IMAGE_RENDER_SCALE: 2,
  IMAGE_JPEG_QUALITY: 0.9,
  // Heurística para reconhecer posters entre as imagens da página
  // (frações do tamanho da página e proporção altura/largura).
  POSTER_MIN_WIDTH_RATIO: 0.04,
  POSTER_MIN_HEIGHT_RATIO: 0.1,
  POSTER_MAX_AREA_RATIO: 0.25,
  POSTER_MIN_ASPECT: 1.1,
  POSTER_MAX_ASPECT: 2.2,
  // Pôster que vai com o filme no envio (capa do card e acervo do filme).
  POSTER_SEND_MAX_HEIGHT: 900,
  POSTER_SEND_QUALITY: 0.86
});

const APP_PHASE = Object.freeze({
  UPLOAD: "upload",
  PROCESSING: "processing",
  REVIEW: "review"
});

const PAGE_STATUS = Object.freeze({
  WAITING: "waiting",
  PROCESSING: "processing",
  SUCCESS: "success",
  ERROR: "error",
  CANCELLED: "cancelled"
});

const STATUS_LABELS = Object.freeze({
  waiting: "Aguardando",
  processing: "Processando",
  success: "Concluída",
  error: "Erro",
  cancelled: "Cancelada"
});

const state = {
  phase: APP_PHASE.UPLOAD,
  sourceFile: null,
  sourceBytes: null,
  pdfDocument: null,
  documentId: null,
  pages: [],
  selectedPageNumber: null,
  isSchedulerRunning: false,
  lastDispatchAt: 0,
  isHealthCheckRunning: false,
  healthCheckIntervalId: null,
  isSaving: false,
  isDirty: false,
  previewRenderTask: null,
  checks: new Map(),
  sessions: new Set(),
  pickingMovieId: null,
  checkTimer: null,
  checkSeq: 0
};

// miniaturas da grade de processamento (uma por página)
const thumbs = new Map();

const THUMB_LABEL = {
  [PAGE_STATUS.WAITING]: "na fila",
  [PAGE_STATUS.PROCESSING]: "lendo…",
  [PAGE_STATUS.SUCCESS]: "pronta",
  [PAGE_STATUS.ERROR]: "erro",
  [PAGE_STATUS.CANCELLED]: "cancelada"
};

let previewResizeTimer = null;
let previewTicket = 0;
let previewRendering = Promise.resolve();

const elements = {
  appShell: document.querySelector("#app-shell"),
  connectionStatus: document.querySelector("#connection-status"),
  connectionStatusLabel: document.querySelector("#connection-status-label"),
  uploadView: document.querySelector("#upload-view"),
  dropZone: document.querySelector("#drop-zone"),
  dropZoneTitle: document.querySelector("#drop-zone-title"),
  dropZoneDescription: document.querySelector("#drop-zone-description"),
  fileInput: document.querySelector("#file-input"),
  selectFileButton: document.querySelector("#select-file-button"),
  uploadLimit: document.querySelector("#upload-limit"),
  validationMessages: document.querySelector("#validation-messages"),
  previewView: document.querySelector("#preview-view"),
  previewFileName: document.querySelector("#preview-file-name"),
  previewPageLabel: document.querySelector("#preview-page-label"),
  previewStage: document.querySelector("#preview-stage"),
  pageThumbs: document.querySelector("#page-thumbs"),
  previewCanvas: document.querySelector("#preview-canvas"),
  previewLoading: document.querySelector("#preview-loading"),
  scanOverlay: document.querySelector("#scan-overlay"),
  scanMessageLabel: document.querySelector("#scan-message-label"),
  scanBeam: document.querySelector("#scan-beam"),
  posterMarks: document.querySelector("#poster-marks"),
  previewStatusMessage: document.querySelector("#preview-status-message"),
  previousPageButton: document.querySelector("#previous-page-button"),
  nextPageButton: document.querySelector("#next-page-button"),
  resultsSide: document.querySelector("#results-side"),
  queueStateMessage: document.querySelector("#queue-state-message"),
  progressDescription: document.querySelector("#progress-description"),
  progressPercentage: document.querySelector("#progress-percentage"),
  progressTrack: document.querySelector("#progress-track"),
  progressBar: document.querySelector("#progress-bar"),
  pageGroups: document.querySelector("#page-groups"),
  stdSummary: document.querySelector("#std-summary"),
  saveButton: document.querySelector("#save-button"),
  saveStateMessage: document.querySelector("#save-state-message"),
  retryAllButton: document.querySelector("#retry-all-button"),
  cancelWaitingButton: document.querySelector("#cancel-waiting-button"),
  replacePdfButton: document.querySelector("#replace-pdf-button"),
  clearButton: document.querySelector("#clear-button")
};

initialize();

function initialize() {
  registerEvents();
  initializeTypewriter();
  initializeMouseGradient();
  initializeHealthCheck();
  elements.uploadLimit.textContent =
    `Limite de ${formatBytes(CONFIG.MAX_FILE_SIZE_BYTES)} por arquivo`;
  setPhase(APP_PHASE.UPLOAD);
  render();
}

function registerEvents() {
  elements.selectFileButton.addEventListener("click", event => {
    event.stopPropagation();
    openFileSelector();
  });

  elements.dropZone.addEventListener("click", event => {
    if (!event.target.closest("button")) openFileSelector();
  });

  elements.dropZone.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openFileSelector();
    }
  });

  elements.fileInput.addEventListener("change", async () => {
    const [file] = elements.fileInput.files;
    if (file) await handlePdfFile(file);
    elements.fileInput.value = "";
  });

  ["dragenter", "dragover"].forEach(name => {
    elements.dropZone.addEventListener(name, event => {
      event.preventDefault();
      elements.dropZone.classList.add("is-dragging");
      elements.dropZoneTitle.textContent = "Pode soltar o PDF";
      elements.dropZoneDescription.textContent =
        "O documento será separado localmente.";
    });
  });

  ["dragleave", "drop"].forEach(name => {
    elements.dropZone.addEventListener(name, event => {
      event.preventDefault();
      resetDropZone();
    });
  });

  elements.dropZone.addEventListener("drop", async event => {
    const [file] = event.dataTransfer.files;
    if (file) await handlePdfFile(file);
  });

  elements.previousPageButton.addEventListener("click", () => navigatePage(-1));
  elements.nextPageButton.addEventListener("click", () => navigatePage(1));
  elements.pageGroups.addEventListener("click", handleGroupClick);
  elements.pageGroups.addEventListener("input", handleMovieInput);
  elements.pageGroups.addEventListener("change", handleMovieInput);
  elements.saveButton.addEventListener("click", saveResults);
  elements.retryAllButton.addEventListener("click", retryAllErrors);
  elements.cancelWaitingButton.addEventListener("click", cancelWaitingPages);
  elements.replacePdfButton.addEventListener("click", replacePdf);
  elements.clearButton.addEventListener("click", clearProject);

  document.addEventListener("click", event => {
    document.querySelectorAll("details[open]").forEach(details => {
      if (!details.contains(event.target)) details.removeAttribute("open");
    });
  });

  elements.scanBeam.addEventListener("animationend", handleScanFinished);
  document.addEventListener("click", event => {
    if (!event.target.closest(".session-menu")) closeSessionMenus();
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") closeSessionMenus();
    if (event.key !== "Escape" || !state.pickingMovieId) return;
    state.pickingMovieId = null;
    renderPageGroup();
    renderPosterMarks();
  });
  window.addEventListener("resize", handlePreviewResize, { passive: true });
  // o preview muda de tamanho também ao trocar de fase (revisão: largura toda)
  if (window.ResizeObserver) {
    let lastWidth = 0;
    new ResizeObserver(([entry]) => {
      const width = Math.round(entry.contentRect.width);
      if (width && Math.abs(width - lastWidth) > 2) {
        lastWidth = width;
        handlePreviewResize();
      }
    }).observe(elements.previewStage);
  }
  window.addEventListener("beforeunload", event => {
    if (hasActivePages() || state.isDirty) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
}

function handlePreviewResize() {
  clearTimeout(previewResizeTimer);
  previewResizeTimer = setTimeout(() => {
    if (state.pdfDocument && state.selectedPageNumber && shouldRenderPreview()) {
      renderSelectedPreview();
    }
  }, 180);
}

function setPhase(phase) {
  state.phase = phase;
  elements.appShell.classList.remove(
    "phase-upload", "phase-processing", "phase-review"
  );
  elements.appShell.classList.add(`phase-${phase}`);
  elements.previewView.hidden = phase === APP_PHASE.UPLOAD;
  if (phase === APP_PHASE.REVIEW) handlePreviewResize();
  elements.resultsSide.setAttribute(
    "aria-hidden", phase === APP_PHASE.REVIEW ? "false" : "true"
  );
}

async function transitionFromUploadToProcessing() {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!reduced) {
    elements.appShell.classList.add("is-upload-expanding");
    await sleep(260);
  }
  elements.appShell.classList.remove("is-upload-expanding");
  setPhase(APP_PHASE.PROCESSING);
  elements.previewView.classList.remove("is-preview-entering");
  void elements.previewView.offsetWidth;
  elements.previewView.classList.add("is-preview-entering");
  setTimeout(() => {
    elements.previewView.classList.remove("is-preview-entering");
  }, reduced ? 0 : 750);
}

function updatePhaseFromQueue() {
  if (!state.pages.length) setPhase(APP_PHASE.UPLOAD);
  else if (hasActivePages()) setPhase(APP_PHASE.PROCESSING);
  else setPhase(APP_PHASE.REVIEW);
}

function openFileSelector() {
  if (hasActivePages()) return;
  elements.fileInput.click();
}

function resetDropZone() {
  elements.dropZone.classList.remove("is-dragging");
  elements.dropZoneTitle.textContent = "Solte a grade aqui";
  elements.dropZoneDescription.textContent =
    "Selecione um arquivo PDF para iniciar.";
}

async function handlePdfFile(file) {
  clearUploadMessages();
  const validation = validatePdf(file);
  if (!validation.valid) {
    showUploadMessage(validation.message, "error");
    return;
  }

  if (state.pages.length && !confirm(
    "O PDF atual e as alterações serão substituídos. Continuar?"
  )) return;

  try {
    setUploadBusy(true);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const pdfDocument = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
    const pageNumbers = getUsefulPageNumbers(pdfDocument.numPages);
    const pages = await splitPdfPages(bytes, pageNumbers, file.name);

    state.sourceFile = file;
    state.sourceBytes = bytes;
    state.pdfDocument = pdfDocument;
    state.documentId = createId();
    state.pages = pages;
    state.selectedPageNumber = pageNumbers[0];
    state.lastDispatchAt = 0;
    state.isDirty = false;
    elements.previewFileName.textContent = file.name;

    await transitionFromUploadToProcessing();
    render();
    await renderSelectedPreview();
    startScheduler();
  } catch (error) {
    console.error("[PDF]", error);
    clearProjectState();
    setPhase(APP_PHASE.UPLOAD);
    showUploadMessage(error?.message || "Não foi possível abrir o PDF.", "error");
  } finally {
    setUploadBusy(false);
  }
}

function getUsefulPageNumbers(pageCount) {
  if (pageCount <= 2) {
    const processAll = confirm(
      `O PDF possui ${pageCount} página(s). Deseja processar todas?`
    );
    if (!processAll) throw new Error("Selecione um PDF com pelo menos três páginas.");
    return Array.from({ length: pageCount }, (_, index) => index + 1);
  }
  return Array.from({ length: pageCount - 2 }, (_, index) => index + 2);
}

function validatePdf(file) {
  if (!(file instanceof File)) return { valid: false, message: "Arquivo inválido." };
  if (file.name.split(".").pop()?.toLowerCase() !== "pdf") {
    return { valid: false, message: "Selecione um arquivo PDF." };
  }
  if (file.size <= 0) return { valid: false, message: "O PDF está vazio." };
  if (file.size > CONFIG.MAX_FILE_SIZE_BYTES) {
    return {
      valid: false,
      message: `O arquivo excede ${formatBytes(CONFIG.MAX_FILE_SIZE_BYTES)}.`
    };
  }
  return { valid: true };
}

async function splitPdfPages(bytes, pageNumbers, originalName) {
  const sourcePdf = await PDFLib.PDFDocument.load(bytes);
  const baseName = originalName.replace(/\.pdf$/i, "");
  const pages = [];

  for (let index = 0; index < pageNumbers.length; index += 1) {
    const originalPageNumber = pageNumbers[index];
    const pagePdf = await PDFLib.PDFDocument.create();
    const [copiedPage] = await pagePdf.copyPages(
      sourcePdf, [originalPageNumber - 1]
    );
    pagePdf.addPage(copiedPage);
    const pageBytes = await pagePdf.save();

    pages.push({
      id: createId(),
      requestId: createId(),
      originalPageNumber,
      usefulPageNumber: index + 1,
      totalUsefulPages: pageNumbers.length,
      fileName: `${baseName}_pagina_${originalPageNumber}.pdf`,
      blob: new Blob([pageBytes], { type: "application/pdf" }),
      status: PAGE_STATUS.WAITING,
      message: "Aguardando processamento.",
      attempts: 0,
      hasScanned: false,
      images: null,
      startedAt: 0,
      finishedAt: 0,
      path: "",
      workflowStatus: "",
      responseId: "",
      movies: []
    });
  }
  return pages;
}

function shouldRenderPreview() {
  return !(state.phase === APP_PHASE.REVIEW && matchMedia("(max-width: 900px)").matches);
}

async function renderSelectedPreview() {
  if (!state.pdfDocument || !state.selectedPageNumber ||
    !shouldRenderPreview() || elements.previewView.hidden) return;
  // durante o processamento o preview é a grade de páginas (renderThumbs)
  if (state.phase === APP_PHASE.PROCESSING) return;

  const selectedPage = getSelectedPage();
  elements.previewPageLabel.textContent = `Página ${state.selectedPageNumber}`;
  elements.previewLoading.hidden = false;

  // uma renderização por vez no mesmo canvas: a nova cancela a anterior, espera
  // ela parar, e só a mais recente segue
  const ticket = ++previewTicket;
  try { state.previewRenderTask?.cancel(); } catch { }
  try { await previewRendering; } catch { }
  if (ticket !== previewTicket) return;

  try {
    const pdfPage = await state.pdfDocument.getPage(state.selectedPageNumber);
    if (ticket !== previewTicket) return;
    // na revisão a página ocupa a largura toda (com rolagem); antes disso, cabe inteira
    const fillWidth = state.phase === APP_PHASE.REVIEW;
    const gap = fillWidth ? 0 : 20;
    const availableWidth = Math.max(320, elements.previewStage.clientWidth - gap);
    const availableHeight = Math.max(200, elements.previewStage.clientHeight - gap);
    const base = pdfPage.getViewport({ scale: 1 });
    const scale = fillWidth
      ? availableWidth / base.width
      : Math.min(availableWidth / base.width, availableHeight / base.height);
    const viewport = pdfPage.getViewport({ scale });
    const canvas = elements.previewCanvas;
    const context = canvas.getContext("2d");
    const ratio = Math.min(devicePixelRatio || 1, 2);

    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;

    state.previewRenderTask = pdfPage.render({
      canvasContext: context,
      viewport,
      transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0]
    });
    previewRendering = state.previewRenderTask.promise;
    await previewRendering;
    animatePreviewCanvas();
    renderPosterMarks();
  } catch (error) {
    if (error?.name !== "RenderingCancelledException") {
      console.error("[Preview]", error);
    }
  } finally {
    elements.previewLoading.hidden = true;
    updatePreviewStatus(selectedPage);
    updatePreviewNavigation();
  }
}

function animatePreviewCanvas() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  elements.previewCanvas.classList.remove("is-page-entering");
  void elements.previewCanvas.offsetWidth;
  elements.previewCanvas.classList.add("is-page-entering");
  setTimeout(() => elements.previewCanvas.classList.remove("is-page-entering"), 520);
}

function updatePreviewStatus(page = getSelectedPage()) {
  const overlay = elements.scanOverlay;
  const isActive = page && (
    page.status === PAGE_STATUS.PROCESSING || page.status === PAGE_STATUS.WAITING
  );

  if (!isActive) {
    overlay.hidden = true;
    overlay.classList.remove("is-scanning", "is-loading");
    delete overlay.dataset.pageId;
    elements.previewStatusMessage.textContent = !page ? ""
      : state.phase === APP_PHASE.REVIEW ? `Página ${page.originalPageNumber}` : page.message;
    return;
  }

  overlay.hidden = false;
  // O feixe do scanner passa apenas duas vezes sobre a página no momento do
  // envio; depois disso fica só um loader simples até o retorno dos dados.
  const shouldScan = page.status === PAGE_STATUS.PROCESSING && !page.hasScanned;
  if (shouldScan && overlay.dataset.pageId !== page.id) {
    overlay.classList.remove("is-scanning");
    void elements.scanBeam.offsetWidth;
  }
  overlay.dataset.pageId = page.id;
  overlay.classList.toggle("is-scanning", shouldScan);
  overlay.classList.toggle("is-loading", !shouldScan);

  elements.scanMessageLabel.textContent = page.status === PAGE_STATUS.WAITING
    ? "Aguardando envio…"
    : shouldScan
      ? `Lendo página ${page.originalPageNumber}…`
      : "Aguardando retorno dos dados…";
  elements.previewStatusMessage.textContent = page.message;
}

function handleScanFinished() {
  const page = state.pages.find(item => item.id === elements.scanOverlay.dataset.pageId);
  if (page) page.hasScanned = true;
  updatePreviewStatus();
}

function updatePreviewNavigation() {
  const index = getSelectedPageIndex();
  elements.previousPageButton.disabled = index <= 0;
  elements.nextPageButton.disabled = index < 0 || index >= state.pages.length - 1;
}

function navigatePage(direction) {
  const page = state.pages[getSelectedPageIndex() + direction];
  if (page) selectPage(page.originalPageNumber);
}

function selectPage(pageNumber) {
  if (!state.pages.some(page => page.originalPageNumber === pageNumber)) return;
  state.selectedPageNumber = pageNumber;
  renderPageGroup();
  renderSelectedPreview();
  updatePreviewStatus();
  updatePreviewNavigation();
}

function getSelectedPage() {
  return state.pages.find(
    page => page.originalPageNumber === state.selectedPageNumber
  );
}

function getSelectedPageIndex() {
  return state.pages.findIndex(
    page => page.originalPageNumber === state.selectedPageNumber
  );
}

function selectMostRecentProcessingPage() {
  const [page] = state.pages
    .filter(item => item.status === PAGE_STATUS.PROCESSING)
    .sort((a, b) => b.startedAt - a.startedAt);
  if (page) state.selectedPageNumber = page.originalPageNumber;
}

async function startScheduler() {
  if (state.isSchedulerRunning) return;
  state.isSchedulerRunning = true;
  render();

  try {
    while (true) {
      const nextPage = state.pages.find(page => page.status === PAGE_STATUS.WAITING);
      if (!nextPage) break;
      await waitForDispatchInterval();
      if (!state.pages.some(page =>
        page.id === nextPage.id && page.status === PAGE_STATUS.WAITING
      )) continue;
      state.lastDispatchAt = Date.now();
      void processPage(nextPage).catch(error => console.error("[Processamento]", error));
    }
  } finally {
    state.isSchedulerRunning = false;
    render();
    if (state.pages.some(page => page.status === PAGE_STATUS.WAITING)) {
      startScheduler();
    }
  }
}

async function waitForDispatchInterval() {
  if (!state.lastDispatchAt) return;
  const waitingTime = state.lastDispatchAt + CONFIG.SEND_INTERVAL_MS - Date.now();
  if (waitingTime > 0) await sleep(waitingTime);
}

async function processPage(page) {
  page.status = PAGE_STATUS.PROCESSING;
  page.message = "Lendo o conteúdo da página…";
  page.attempts += 1;
  page.hasScanned = false;
  page.thumbScanned = false;
  page.startedAt = Date.now();
  state.selectedPageNumber = page.originalPageNumber;
  setPhase(APP_PHASE.PROCESSING);
  render();
  await renderSelectedPreview();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CONFIG.PROCESS_TIMEOUT_MS);

  try {
    const formData = new FormData();
    formData.append(CONFIG.FILE_FIELD_NAME, page.blob, page.fileName);
    formData.append("request_id", page.requestId);
    formData.append("document_id", state.documentId);
    formData.append("original_file_name", state.sourceFile.name);
    formData.append("original_page_number", String(page.originalPageNumber));
    formData.append("useful_page_number", String(page.usefulPageNumber));
    formData.append("total_useful_pages", String(page.totalUsefulPages));
    await appendPageImages(formData, page);

    const response = await fetch(CONFIG.PROCESS_WEBHOOK_URL, {
      method: "POST",
      body: formData,
      credentials: "omit",
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(extractErrorMessage(text) || explainHttpError(response, "N8N_PROCESS_WEBHOOK_URL"));
    }

    const result = parsePageResponse(text);
    page.path = result.path;
    page.workflowStatus = result.status;
    page.responseId = result.ID;
    page.movies = result.movies.map(normalizeMovie);
    // as sessões cadastradas (o fluxo manda junto) e as que vieram nos filmes viram as opções do campo
    for (const name of [...result.sessions, ...page.movies.map(movie => movie.sessao)]) addSession(name);
    assignPosters(page);
    page.status = PAGE_STATUS.SUCCESS;
    page.message = `${page.movies.length} filme(s) identificado(s).`;
    state.isDirty = true;
    scheduleCheck();
  } catch (error) {
    page.status = PAGE_STATUS.ERROR;
    page.message = getRequestErrorMessage(error);
  } finally {
    clearTimeout(timeoutId);
    page.finishedAt = Date.now();
    updatePhaseFromQueue();
    updateSelectionAfterPageFinished();
    render();
    if (shouldRenderPreview()) await renderSelectedPreview();
  }
}

function updateSelectionAfterPageFinished() {
  if (hasActivePages()) {
    // Ainda há páginas em processamento ou aguardando: continua
    // acompanhando a página mais recentemente enviada.
    selectMostRecentProcessingPage();
  } else if (state.pages.length) {
    // Processamento completo: volta a exibir a primeira página.
    state.selectedPageNumber = state.pages[0].originalPageNumber;
  }
}

async function appendPageImages(formData, page) {
  try {
    if (!page.images) page.images = await extractPageImages(page.originalPageNumber);
  } catch (error) {
    // Falha na extração das imagens não impede o envio do PDF da página.
    console.error("[Imagens]", error);
    formData.append("poster_count", "0");
    return;
  }
  const baseName = page.fileName.replace(/\.pdf$/i, "");
  const { pageImage, posters } = page.images;
  formData.append(CONFIG.PAGE_IMAGE_FIELD_NAME, pageImage, `${baseName}.jpg`);
  formData.append("poster_count", String(posters.length));
  formData.append("poster_boxes", JSON.stringify(posters.map(poster => poster.box)));
  posters.forEach((poster, index) => {
    const number = index + 1;
    formData.append(
      `${CONFIG.POSTER_FIELD_PREFIX}${number}`,
      poster.blob,
      `${baseName}_poster_${String(number).padStart(2, "0")}.jpg`
    );
  });
}

/**
 * Renderiza a página em alta resolução e recorta os posters a partir das
 * posições em que as imagens são desenhadas no PDF, em ordem de leitura
 * (linhas de cima para baixo, e da esquerda para a direita em cada linha).
 */
async function extractPageImages(pageNumber) {
  const pdfPage = await state.pdfDocument.getPage(pageNumber);
  const viewport = pdfPage.getViewport({ scale: CONFIG.IMAGE_RENDER_SCALE });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  await pdfPage.render({ canvasContext: context, viewport }).promise;

  const boxes = sortBoxesInReadingOrder(
    filterPosterBoxes(await getImageBoxes(pdfPage, viewport), canvas)
  );
  const pageImage = await canvasToJpeg(canvas);
  const posters = [];
  for (const box of boxes) {
    const crop = document.createElement("canvas");
    crop.width = box.width;
    crop.height = box.height;
    crop.getContext("2d").drawImage(
      canvas, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height
    );
    const blob = await canvasToJpeg(crop);
    posters.push({ box, blob, url: URL.createObjectURL(blob) });
  }
  const texts = await getTextLines(pdfPage, viewport).catch(() => []);
  const size = { width: canvas.width, height: canvas.height };
  canvas.width = canvas.height = 0;
  return { pageImage, posters, texts, size };
}

async function getImageBoxes(pdfPage, viewport) {
  const { OPS, Util } = pdfjsLib;
  const imageOps = new Set([
    OPS.paintImageXObject,
    OPS.paintInlineImageXObject,
    OPS.paintImageXObjectRepeat,
    OPS.paintJpegXObject
  ].filter(op => op !== undefined));
  const operatorList = await pdfPage.getOperatorList();
  const boxes = [];
  const stack = [];
  let matrix = viewport.transform.slice();

  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const fn = operatorList.fnArray[index];
    const args = operatorList.argsArray[index];
    if (fn === OPS.save) stack.push(matrix);
    else if (fn === OPS.restore) matrix = stack.pop() || matrix;
    else if (fn === OPS.transform) matrix = Util.transform(matrix, args);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(matrix);
      if (Array.isArray(args?.[0]) && args[0].length === 6) {
        matrix = Util.transform(matrix, args[0]);
      }
    } else if (fn === OPS.paintFormXObjectEnd) matrix = stack.pop() || matrix;
    else if (imageOps.has(fn)) {
      // Imagens são desenhadas no quadrado unitário do espaço atual.
      const corners = [[0, 0], [1, 0], [0, 1], [1, 1]]
        .map(point => Util.applyTransform(point, matrix));
      const xs = corners.map(point => point[0]);
      const ys = corners.map(point => point[1]);
      boxes.push({
        left: Math.min(...xs),
        top: Math.min(...ys),
        right: Math.max(...xs),
        bottom: Math.max(...ys)
      });
    }
  }
  return boxes;
}

// Linhas de texto da página (em pixels da imagem renderizada), para achar o
// título de cada filme e, logo acima dele, o seu pôster.
async function getTextLines(pdfPage, viewport) {
  const content = await pdfPage.getTextContent();
  const lines = [];
  for (const item of content.items) {
    if (!item.str || !item.str.trim()) continue;
    const [x, y] = pdfjsLib.Util.applyTransform([item.transform[4], item.transform[5]], viewport.transform);
    const height = Math.hypot(item.transform[2], item.transform[3]) * viewport.scale;
    const width = item.width * viewport.scale;
    const line = lines.find(other => Math.abs(other.baseline - y) < height * 0.6 && x - (other.x + other.width) < height * 1.5 && x >= other.x - 2);
    if (line) {
      line.str += (x - (line.x + line.width) > height * 0.15 ? " " : "") + item.str;
      line.width = Math.max(line.width, x + width - line.x);
    } else {
      lines.push({ str: item.str, x, baseline: y, top: y - height, width, height });
    }
  }
  return lines;
}

// Liga cada filme ao pôster logo acima do seu título; se não achar o título,
// e a página tiver um pôster por filme, vai pela ordem de leitura.
function assignPosters(page) {
  const images = page.images;
  if (!images || !images.posters.length) return;
  const used = new Set();
  const byTitle = page.movies.map(movie => {
    const key = compact(movie.titulo);
    if (key.length < 2) return null;
    const lines = images.texts.filter(line => {
      const text = compact(line.str);
      return text && (text === key || (text.startsWith(key) && key.length >= 4) || (key.startsWith(text) && text.length >= 6));
    });
    let best = null;
    for (const line of lines) {
      images.posters.forEach((poster, index) => {
        const { x, y, width, height } = poster.box;
        const overlap = Math.min(x + width, line.x + line.width) - Math.max(x, line.x);
        const gap = line.top - (y + height);
        if (overlap <= 0 || gap < -height * 0.15 || gap > height * 0.6) return;
        const score = gap - overlap * 0.01;
        if (!best || score < best.score) best = { index, score };
      });
    }
    return best ? best.index : null;
  });
  page.movies.forEach((movie, index) => {
    if (movie.posterTouched) return;
    let chosen = byTitle[index];
    if (chosen === null && images.posters.length === page.movies.length) chosen = index;
    if (chosen !== null && used.has(chosen)) chosen = null;
    if (chosen !== null) used.add(chosen);
    movie.poster = chosen;
  });
}

function filterPosterBoxes(boxes, canvas) {
  const pageWidth = canvas.width;
  const pageHeight = canvas.height;
  const candidates = boxes
    .map(box => {
      const left = Math.max(0, Math.round(box.left));
      const top = Math.max(0, Math.round(box.top));
      const right = Math.min(pageWidth, Math.round(box.right));
      const bottom = Math.min(pageHeight, Math.round(box.bottom));
      return { x: left, y: top, width: right - left, height: bottom - top };
    })
    .filter(box => {
      if (box.width <= 0 || box.height <= 0) return false;
      const aspect = box.height / box.width;
      return box.width >= pageWidth * CONFIG.POSTER_MIN_WIDTH_RATIO &&
        box.height >= pageHeight * CONFIG.POSTER_MIN_HEIGHT_RATIO &&
        box.width * box.height <= pageWidth * pageHeight * CONFIG.POSTER_MAX_AREA_RATIO &&
        aspect >= CONFIG.POSTER_MIN_ASPECT &&
        aspect <= CONFIG.POSTER_MAX_ASPECT;
    });

  // Remove imagens sobrepostas (ex.: a mesma arte desenhada duas vezes),
  // mantendo a maior.
  candidates.sort((a, b) => b.width * b.height - a.width * a.height);
  return candidates.filter((box, index) => !candidates.slice(0, index).some(other => {
    const overlapWidth = Math.min(box.x + box.width, other.x + other.width) - Math.max(box.x, other.x);
    const overlapHeight = Math.min(box.y + box.height, other.y + other.height) - Math.max(box.y, other.y);
    return overlapWidth > 0 && overlapHeight > 0 &&
      overlapWidth * overlapHeight >= box.width * box.height * 0.5;
  }));
}

function sortBoxesInReadingOrder(boxes) {
  const rows = [];
  [...boxes].sort((a, b) => a.y - b.y).forEach(box => {
    const center = box.y + box.height / 2;
    const row = rows.find(item => center >= item.top && center <= item.bottom);
    if (row) {
      row.boxes.push(box);
      row.top = Math.min(row.top, box.y);
      row.bottom = Math.max(row.bottom, box.y + box.height);
    } else {
      rows.push({ top: box.y, bottom: box.y + box.height, boxes: [box] });
    }
  });
  return rows
    .sort((a, b) => a.top - b.top)
    .flatMap(row => row.boxes.sort((a, b) => a.x - b.x));
}

function canvasToJpeg(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      blob => blob ? resolve(blob) : reject(new Error("Falha ao gerar imagem.")),
      "image/jpeg",
      CONFIG.IMAGE_JPEG_QUALITY
    );
  });
}

/* ---------------------------------------------------------
   Processamento: grade com as páginas pequenas, cada uma com o
   scanner (duas passadas) e o loader enquanto o n8n lê
   --------------------------------------------------------- */

function renderThumbs() {
  const box = elements.pageThumbs;
  if (!box) return;
  // páginas que saíram (outro PDF): somem da grade
  for (const [id, thumb] of thumbs) {
    if (!state.pages.some(page => page.id === id)) { thumb.element.remove(); thumbs.delete(id); }
  }
  const processing = state.phase === APP_PHASE.PROCESSING && state.pages.length > 0;
  box.hidden = !processing;
  elements.previewStage.hidden = processing;
  if (!processing) return;
  for (const page of state.pages) {
    let thumb = thumbs.get(page.id);
    if (!thumb) {
      thumb = createThumb(page);
      thumbs.set(page.id, thumb);
      box.append(thumb.element);
    }
    const { element, beam, label } = thumb;
    element.dataset.status = page.status;
    element.classList.toggle("is-selected", page.originalPageNumber === state.selectedPageNumber);
    const scanning = page.status === PAGE_STATUS.PROCESSING && !page.thumbScanned;
    if (scanning && !element.classList.contains("is-scanning")) {
      element.classList.remove("is-scanning");
      void beam.offsetWidth;
    }
    element.classList.toggle("is-scanning", scanning);
    element.classList.toggle("is-loading", page.status === PAGE_STATUS.PROCESSING && Boolean(page.thumbScanned));
    label.textContent = `Página ${page.originalPageNumber} · ${THUMB_LABEL[page.status] || ""}`;
  }
}

function createThumb(page) {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "page-thumb";
  element.addEventListener("click", () => selectPage(page.originalPageNumber));
  const sheet = document.createElement("span");
  sheet.className = "page-thumb-sheet";
  const canvas = document.createElement("canvas");
  const beam = document.createElement("span");
  beam.className = "page-thumb-beam";
  beam.addEventListener("animationend", () => {
    page.thumbScanned = true;
    renderThumbs();
  });
  const loader = document.createElement("span");
  loader.className = "page-thumb-loader";
  loader.append(document.createElement("i"));
  sheet.append(canvas, beam, loader);
  const label = document.createElement("span");
  label.className = "page-thumb-label";
  element.append(sheet, label);
  drawThumb(page, canvas);
  return { element, beam, label };
}

async function drawThumb(page, canvas) {
  try {
    const pdfPage = await state.pdfDocument.getPage(page.originalPageNumber);
    const base = pdfPage.getViewport({ scale: 1 });
    const viewport = pdfPage.getViewport({ scale: 960 / base.width });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await pdfPage.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  } catch (error) {
    console.warn("[Miniatura]", error);
  }
}

function parsePageResponse(text) {
  if (!text.trim()) throw new Error("O workflow retornou resposta vazia.");
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error("O workflow retornou JSON inválido."); }
  const result = Array.isArray(data) ? data[0] : data;
  if (!result || typeof result !== "object" || !Array.isArray(result.movies)) {
    throw new Error('A resposta não contém o array "movies".');
  }
  return {
    path: typeof result.path === "string" ? result.path : "",
    status: typeof result.status === "string" ? result.status : "",
    ID: typeof result.ID === "string" ? result.ID : "",
    movies: result.movies,
    sessions: Array.isArray(result.sessoes) ? result.sessoes.filter(item => typeof item === "string") : []
  };
}

function normalizeMovie(movie) {
  return {
    id: createId(),
    titulo: typeof movie?.titulo === "string" ? movie.titulo : "",
    ano_de_producao: typeof movie?.ano_de_producao === "string"
      ? movie.ano_de_producao : String(movie?.ano_de_producao || ""),
    sessao: typeof movie?.sessao === "string" ? movie.sessao : "",
    data: typeof movie?.data === "string" ? movie.data : "",
    inedito: movie?.inedito === true,
    poster: null,
    posterTouched: false
  };
}

function render() {
  const counts = getCounts();
  renderProgress(counts);
  renderQueueState(counts);
  renderControls(counts);
  renderPageGroup();
  renderSaveState();
  renderPosterMarks();
  renderThumbs();
  if (state.sourceFile) {
    elements.previewFileName.textContent = state.sourceFile.name;
    elements.previewPageLabel.textContent = `Página ${state.selectedPageNumber}`;
    updatePreviewNavigation();
    updatePreviewStatus();
  }
}

function getCounts() {
  const count = status => state.pages.filter(page => page.status === status).length;
  return {
    total: state.pages.length,
    waiting: count(PAGE_STATUS.WAITING),
    processing: count(PAGE_STATUS.PROCESSING),
    success: count(PAGE_STATUS.SUCCESS),
    error: count(PAGE_STATUS.ERROR),
    cancelled: count(PAGE_STATUS.CANCELLED)
  };
}

function renderProgress(counts) {
  const finished = counts.success + counts.error + counts.cancelled;
  const percentage = counts.total ? Math.round(finished / counts.total * 100) : 0;
  elements.progressBar.style.width = `${percentage}%`;
  elements.progressPercentage.textContent = `${percentage}%`;
  elements.progressTrack.setAttribute("aria-valuenow", String(percentage));
  elements.progressDescription.textContent = counts.total
    ? `${finished} de ${counts.total} páginas finalizadas`
    : "Nenhuma página processada";
}

function renderQueueState(counts) {
  if (!counts.total) elements.queueStateMessage.textContent = "Selecione uma grade em PDF para começar.";
  else if (counts.error) elements.queueStateMessage.textContent = "Finalizado com páginas que precisam de atenção.";
  else elements.queueStateMessage.textContent = hasActivePages()
    ? "Todas as páginas disponíveis foram finalizadas."
    : checkSummary() || "Todas as páginas disponíveis foram finalizadas.";
}

function renderControls(counts) {
  elements.retryAllButton.hidden = !counts.error;
  elements.retryAllButton.disabled = !counts.error;
  elements.cancelWaitingButton.disabled = !counts.waiting;
  elements.replacePdfButton.disabled = !state.sourceFile || hasActivePages();
  elements.clearButton.disabled = !state.pages.length || hasActivePages();
}

function renderPageGroup() {
  elements.pageGroups.replaceChildren();
  const page = getSelectedPage();
  if (page) elements.pageGroups.append(createPageGroup(page));
  renderStdSummary();
}

/* ---------------------------------------------------------
   Sessão da Tarde: todos os títulos do PDF num bloco só, como o
   card resumo que vai para o Trello (os títulos a produzir no
   checklist, os que já existem só na descrição)
   --------------------------------------------------------- */

const isStd = movie => /^SESS[ÃA]O\s*DA\s*TARDE$/i.test(movie.sessao.trim());

function stdGroups() {
  // só os filmes da página aberta; um título por filme (o mesmo filme pode passar em mais de um dia na página)
  const groups = [];
  const selected = getSelectedPage();
  for (const page of state.pages.filter(item => item === selected && item.status === PAGE_STATUS.SUCCESS)) {
    for (const movie of page.movies.filter(isStd)) {
      const key = movie.titulo.trim().toUpperCase() || movie.id;
      const group = groups.find(item => item.key === key);
      if (group) group.movies.push(movie);
      else groups.push({ key, page, movies: [movie] });
    }
  }
  return groups;
}

function renderStdSummary() {
  const box = elements.stdSummary;
  if (!box) return;
  const groups = stdGroups();
  box.replaceChildren();
  box.hidden = !groups.length;
  if (box.hidden) return;
  const header = document.createElement("header");
  header.className = "std-divider";
  const title = document.createElement("h3");
  title.textContent = "Sessão da Tarde";
  const meta = document.createElement("span");
  meta.hidden = true;
  meta.textContent = groups.length
    ? `${groups.length} ${groups.length === 1 ? "título nesta página" : "títulos nesta página"} · um card só no Trello`
    : "";
  header.append(title, meta);
  const list = document.createElement("ol");
  for (const group of groups) {
    const first = group.movies[0];
    const li = document.createElement("li");
    li.dataset.stdKey = first.id;
    const poster = group.page.images?.posters[first.poster];
    if (poster) {
      const image = document.createElement("img");
      image.src = poster.url;
      image.alt = "";
      li.append(image);
    }
    const input = document.createElement("input");
    input.type = "text";
    input.className = "std-input";
    input.value = first.titulo;
    input.placeholder = "Título do filme";
    input.setAttribute("aria-label", "Título do filme da Sessão da Tarde");
    input.addEventListener("input", () => {
      for (const movie of group.movies) movie.titulo = input.value;
      state.isDirty = true;
      renderSaveState();
    });
    input.addEventListener("focus", () => highlightPosterMark(first.poster));
    input.addEventListener("blur", () => highlightPosterMark(null));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "std-remove";
    remove.setAttribute("aria-label", `Tirar ${first.titulo || "o título"} da Sessão da Tarde`);
    remove.title = "Tirar da lista";
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      for (const page of state.pages) page.movies = page.movies.filter(movie => !group.movies.includes(movie));
      state.isDirty = true;
      renderPageGroup();
      renderPosterMarks();
      renderSaveState();
    });
    // de volta para a grade das outras sessões (a data e o resto dos dados continuam lá)
    const out = document.createElement("button");
    out.type = "button";
    out.className = "std-out";
    out.title = "Não é Sessão da Tarde: levar para as outras sessões";
    out.setAttribute("aria-label", `Levar ${first.titulo || "o filme"} para as outras sessões`);
    out.innerHTML = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M8 12.5v-9M4 7.5l4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    out.addEventListener("click", () => {
      for (const movie of group.movies) movie.sessao = "";
      state.isDirty = true;
      renderPageGroup();
      renderPosterMarks();
      renderSaveState();
      const card = document.querySelector(`[data-movie-card="${first.id}"]`);
      card?.classList.add("is-flash");
      card?.querySelector(".session-button")?.focus();
    });
    li.append(input, out, remove);
    li.addEventListener("pointerenter", () => highlightPosterMark(first.poster));
    li.addEventListener("pointerleave", () => highlightPosterMark(null));
    list.append(li);
  }
  const add = document.createElement("button");
  add.type = "button";
  add.className = "std-add";
  add.textContent = "+ título";
  add.title = "Incluir um filme na Sessão da Tarde";
  add.addEventListener("click", () => {
    const target = getSelectedPage();
    if (target?.status !== PAGE_STATUS.SUCCESS) return;
    const movie = { id: createId(), titulo: "", ano_de_producao: "", sessao: "SESSÃO DA TARDE", data: "", inedito: false, poster: null, posterTouched: true };
    target.movies.push(movie);
    state.isDirty = true;
    renderStdSummary();
    renderSaveState();
    box.querySelector(`[data-std-key="${movie.id}"] input`)?.focus();
  });
  box.append(header, list);
}

function createPageGroup(page) {
  const group = document.createElement("section");
  group.className = "page-group";
  const header = document.createElement("header");
  header.className = "page-group-header";
  const nav = document.createElement("div");
  nav.className = "page-group-navigation";
  const previous = createNavigationButton("←", -1, "Página anterior");
  const next = createNavigationButton("→", 1, "Próxima página");
  const index = state.pages.findIndex(item => item.id === page.id);
  previous.disabled = index <= 0;
  next.disabled = index >= state.pages.length - 1;
  const title = document.createElement("button");
  title.type = "button";
  title.className = "page-selector";
  const name = document.createElement("span");
  name.textContent = `Página ${page.originalPageNumber}`;
  const meta = document.createElement("span");
  meta.className = "page-meta";
  meta.textContent = page.status === PAGE_STATUS.SUCCESS
    ? `${page.movies.length} ${page.movies.length === 1 ? "filme identificado" : "filmes identificados"}`
    : `${formatAttempts(page.attempts)}`;
  title.append(name, meta);
  nav.append(previous, title, next);
  const actions = document.createElement("div");
  actions.className = "page-group-actions";
  if (page.status === PAGE_STATUS.SUCCESS) {
    const add = document.createElement("button");
    add.type = "button";
    add.className = "small-action add-movie-small";
    add.dataset.addMovie = page.id;
    add.title = "Adicionar um filme nesta página";
    add.textContent = "+ Filme";
    actions.append(add);
  }
  actions.append(createStatusPill(page.status));
  if (page.status === PAGE_STATUS.ERROR) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "small-action";
    retry.dataset.retryPage = page.id;
    retry.textContent = "Reenviar";
    actions.append(retry);
  }
  header.append(nav, actions);
  group.append(header);
  const message = document.createElement("p");
  message.className = "page-message";
  message.textContent = page.message;
  // com a página pronta, a contagem já está no cabeçalho
  if (page.status !== PAGE_STATUS.SUCCESS) group.append(message);

  if (page.status === PAGE_STATUS.SUCCESS) {
    const grid = document.createElement("div");
    grid.className = "movie-grid";
    const columns = pageColumns(page);
    if (columns) grid.style.setProperty("--page-columns", String(columns));
    grid.append(...layoutItems(page).map(item => item.movie
      ? createMovieCard(page, item.movie)
      : createGhostCard(page, item.poster)));
    group.append(grid);
    if (elements.stdSummary) group.append(elements.stdSummary);
  }
  return group;
}

function createNavigationButton(label, direction, ariaLabel) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "page-navigation-button";
  button.dataset.navigatePage = String(direction);
  button.setAttribute("aria-label", ariaLabel);
  button.innerHTML = arrowIcon(direction);
  return button;
}

function arrowIcon(direction) {
  const path = direction < 0 ? "M12.5 8H3.5M7.5 4 3.5 8l4 4" : "M3.5 8h9M8.5 4l4 4-4 4";
  return `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="${path}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function createStatusPill(status) {
  const pill = document.createElement("span");
  pill.className = `status-pill status-${status}`;
  if (status === PAGE_STATUS.PROCESSING) {
    const spinner = document.createElement("span");
    spinner.className = "processing-spinner";
    pill.append(spinner);
  }
  const label = document.createElement("span");
  label.textContent = STATUS_LABELS[status];
  pill.append(label);
  return pill;
}

// A grade segue a página: os filmes na ordem dos pôsteres e, no lugar de cada
// pôster sem filme (cancelado, fora da agenda), um card fantasma. Filmes sem
// pôster vêm no fim.
function layoutItems(page) {
  // a Sessão da Tarde não tem card na grade: o título dela se revisa na lista de cima
  const posters = page.images?.posters || [];
  if (!posters.length) return page.movies.filter(movie => !isStd(movie)).map(movie => ({ movie }));
  const items = posters.flatMap((_, index) => {
    const movie = page.movies.find(item => item.poster === index);
    if (movie && isStd(movie)) return [];
    return [movie ? { movie } : { poster: index }];
  });
  return items.concat(page.movies.filter(movie => !posters[movie.poster] && !isStd(movie)).map(movie => ({ movie })));
}

// Quantos pôsteres a fileira mais cheia da página tem: a grade de cards usa
// essas colunas, para cada card ficar na mesma coluna do seu pôster.
function pageColumns(page) {
  const posters = page.images?.posters || [];
  if (!posters.length) return 0;
  const rows = [];
  for (const { box } of posters) {
    const center = box.y + box.height / 2;
    const row = rows.find(item => center >= item.top && center <= item.bottom);
    if (row) row.count += 1;
    else rows.push({ top: box.y, bottom: box.y + box.height, count: 1 });
  }
  return Math.max(...rows.map(row => row.count));
}

// O texto logo abaixo do pôster na página (título, "CANCELADO"...), para o fantasma.
function textBelowPoster(page, index) {
  const { box } = page.images.posters[index];
  const lines = page.images.texts
    .filter(line => {
      const overlap = Math.min(box.x + box.width, line.x + line.width) - Math.max(box.x, line.x);
      const gap = line.top - (box.y + box.height);
      return overlap > 0 && gap > -box.height * 0.1 && gap < box.height * 0.45;
    })
    .sort((a, b) => a.top - b.top);
  const title = lines.find(line => !/^\(?\d{4}\)?$/.test(line.str.trim()) && !/EXIBI[ÇC][ÃA]O/i.test(line.str));
  const year = lines.map(line => line.str.match(/\((\d{4})\)/)?.[1]).find(Boolean) || "";
  return { title: title ? title.str.trim() : "", year };
}

function createGhostCard(page, index) {
  const card = document.createElement("article");
  card.className = "movie-card is-ghost";
  card.dataset.ghostPoster = String(index);
  const thumb = document.createElement("div");
  thumb.className = "poster-thumb is-ghost";
  const image = document.createElement("img");
  image.src = page.images.posters[index].url;
  image.alt = "";
  thumb.append(image);
  const { title, year } = textBelowPoster(page, index);
  const body = document.createElement("div");
  body.className = "ghost-body";
  const label = document.createElement("strong");
  label.textContent = title || "Sem filme";
  const hint = document.createElement("span");
  hint.textContent = "fora da grade: cancelado ou sem agenda";
  const include = document.createElement("button");
  include.type = "button";
  include.className = "check-apply";
  include.dataset.includePoster = String(index);
  include.dataset.pageId = page.id;
  include.dataset.title = title;
  include.dataset.year = year;
  include.textContent = "incluir";
  body.append(label, hint, include);
  card.append(thumb, body);
  card.addEventListener("pointerenter", () => highlightPosterMark(index));
  card.addEventListener("pointerleave", () => highlightPosterMark(null));
  return card;
}

function includeGhost(button) {
  const page = state.pages.find(item => item.id === button.dataset.pageId);
  if (!page) return;
  const movie = {
    id: createId(), titulo: titleCase(button.dataset.title || ""), ano_de_producao: button.dataset.year || "",
    sessao: "", data: "", inedito: false, poster: Number(button.dataset.includePoster), posterTouched: true
  };
  page.movies.push(movie);
  state.isDirty = true;
  renderPageGroup();
  renderPosterMarks();
  renderSaveState();
  scheduleCheck();
  const card = document.querySelector(`[data-movie-card="${movie.id}"]`);
  card?.classList.add("is-flash");
  card?.querySelector(`[data-movie-field="${movie.titulo ? "sessao" : "titulo"}"]`)?.focus();
}

function titleCase(text) {
  const small = new Set(["a", "o", "as", "os", "de", "da", "do", "das", "dos", "e", "em", "na", "no", "nas", "nos", "por", "para", "com", "um", "uma"]);
  return text.toLocaleLowerCase("pt-BR").split(/(\s+)/).map((word, index) =>
    index > 0 && small.has(word) ? word : word.charAt(0).toLocaleUpperCase("pt-BR") + word.slice(1)
  ).join("");
}

function createMovieCard(page, movie) {
  const card = document.createElement("article");
  card.className = "movie-card";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "remove-movie-button";
  remove.dataset.pageId = page.id;
  remove.dataset.removeMovie = movie.id;
  remove.setAttribute("aria-label", `Remover ${movie.titulo || "filme"}`);
  remove.title = "Remover filme";

  card.dataset.movieCard = movie.id;
  card.classList.toggle("has-poster", Boolean(page.images?.posters.length));
  const top = document.createElement("div");
  top.className = "movie-top-row";
  const session = createSessionField(page, movie);
  const premiere = document.createElement("label");
  premiere.className = "premiere-field";
  const checkbox = createMovieInput(page, movie, "inedito", "checkbox");
  checkbox.checked = movie.inedito;
  premiere.append(checkbox, document.createTextNode("Inédito"));
  top.append(session, premiere);

  const title = createTextField(page, movie, "titulo", "Título", movie.titulo, "text", "title-input");
  title.classList.add("movie-title-field");
  const bottom = document.createElement("div");
  bottom.className = "movie-secondary-fields";
  const year = createTextField(page, movie, "ano_de_producao", "Ano", movie.ano_de_producao);
  year.querySelector("input").inputMode = "numeric";
  year.querySelector("input").maxLength = 4;
  // Sessão da Tarde é arte padrão (o que se produz é o título): a data não aparece
  if (isStd(movie)) {
    bottom.classList.add("is-std");
    bottom.append(year);
  } else {
    bottom.append(year, createTextField(page, movie, "data", "Data de exibição", movie.data, "date"));
  }
  const check = document.createElement("div");
  check.className = "movie-check";
  check.dataset.checkFor = movie.id;
  fillCheck(check, page, movie);
  const fields = document.createElement("div");
  fields.className = "movie-fields";
  fields.append(top, title, bottom, check);
  if (page.images?.posters.length) {
    card.append(remove, createPosterThumb(page, movie), fields);
    if (state.pickingMovieId === movie.id) card.append(createPosterPicker(page, movie));
  } else {
    card.append(remove, fields);
  }
  card.addEventListener("pointerenter", () => highlightPosterMark(movie.poster));
  card.addEventListener("pointerleave", () => highlightPosterMark(null));
  return card;
}

function createPosterThumb(page, movie) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "poster-thumb";
  button.dataset.pickPoster = movie.id;
  button.setAttribute("aria-expanded", String(state.pickingMovieId === movie.id));
  const poster = page.images.posters[movie.poster];
  if (poster) {
    const image = document.createElement("img");
    image.src = poster.url;
    image.alt = "";
    button.append(image);
    button.title = "Trocar o pôster";
    button.setAttribute("aria-label", `Trocar o pôster de ${movie.titulo || "filme"}`);
  } else {
    button.classList.add("is-empty");
    button.textContent = "sem pôster";
    button.title = "Escolher o pôster";
  }
  return button;
}

function createPosterPicker(page, movie) {
  const picker = document.createElement("div");
  picker.className = "poster-picker";
  picker.setAttribute("role", "listbox");
  picker.setAttribute("aria-label", "Pôsteres da página");
  const option = (index, content, label) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "poster-option";
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(movie.poster === index));
    button.dataset.setPoster = movie.id;
    button.dataset.posterIndex = index === null ? "" : String(index);
    button.title = label;
    button.append(content);
    const owner = index === null ? null : page.movies.find(other => other !== movie && other.poster === index);
    if (owner) button.classList.add("is-taken");
    picker.append(button);
  };
  page.images.posters.forEach((poster, index) => {
    const image = document.createElement("img");
    image.src = poster.url;
    image.alt = "";
    option(index, image, `Pôster ${index + 1}`);
  });
  option(null, document.createTextNode("sem"), "Sem pôster");
  const hint = document.createElement("p");
  hint.className = "poster-hint";
  hint.textContent = "ou clique no pôster na página";
  picker.append(hint);
  return picker;
}

function setMoviePoster(movieId, index) {
  const found = findMovie(movieId);
  if (!found) return;
  // um pôster é de um filme só: quem tinha esse fica sem
  if (index !== null) {
    for (const other of found.page.movies) {
      if (other !== found.movie && other.poster === index) { other.poster = null; other.posterTouched = true; }
    }
  }
  found.movie.poster = index;
  found.movie.posterTouched = true;
  state.pickingMovieId = null;
  state.isDirty = true;
  renderPageGroup();
  renderPosterMarks();
  renderSaveState();
}

/* Marcas dos pôsteres por cima do preview */

function renderPosterMarks() {
  const layer = elements.posterMarks;
  if (!layer) return;
  layer.replaceChildren();
  const page = state.pages.find(item => item.originalPageNumber === state.selectedPageNumber);
  const images = page?.images;
  const canvas = elements.previewCanvas;
  if (!page || page.status !== PAGE_STATUS.SUCCESS || !images?.posters.length || !canvas.width) {
    layer.hidden = true;
    return;
  }
  // medidas do layout (sem a animação de entrada da página)
  Object.assign(layer.style, {
    left: `${canvas.offsetLeft}px`,
    top: `${canvas.offsetTop}px`,
    width: `${canvas.offsetWidth}px`,
    height: `${canvas.offsetHeight}px`
  });
  layer.hidden = false;
  layer.classList.toggle("is-picking", Boolean(state.pickingMovieId));
  images.posters.forEach((poster, index) => {
    const mark = document.createElement("button");
    mark.type = "button";
    mark.className = "poster-mark";
    mark.dataset.markIndex = String(index);
    const owner = page.movies.find(movie => movie.poster === index);
    if (owner) {
      mark.classList.add("is-linked");
      mark.title = owner.titulo || "";
    } else {
      mark.title = "Pôster sem filme";
    }
    const { x, y, width, height } = poster.box;
    Object.assign(mark.style, {
      left: `${x / images.size.width * 100}%`,
      top: `${y / images.size.height * 100}%`,
      width: `${width / images.size.width * 100}%`,
      height: `${height / images.size.height * 100}%`
    });
    mark.addEventListener("click", () => {
      if (state.pickingMovieId) return setMoviePoster(state.pickingMovieId, index);
      const stdInput = owner && isStd(owner)
        && [...document.querySelectorAll("[data-std-key]")].find(li => stdGroups().some(group => group.movies.includes(owner) && group.movies[0].id === li.dataset.stdKey))?.querySelector("input");
      if (stdInput) {
        stdInput.scrollIntoView({ block: "nearest", behavior: "smooth" });
        stdInput.focus();
        stdInput.select();
        return;
      }
      const target = owner
        ? document.querySelector(`[data-movie-card="${owner.id}"]`)
        : document.querySelector(`[data-ghost-poster="${index}"]`);
      if (target) {
        target.scrollIntoView({ block: "nearest", behavior: "smooth" });
        target.classList.remove("is-flash");
        void target.offsetWidth;
        target.classList.add("is-flash");
      }
    });
    mark.addEventListener("pointerenter", () => {
      (owner
        ? document.querySelector(`[data-movie-card="${owner.id}"]`)
        : document.querySelector(`[data-ghost-poster="${index}"]`))?.classList.add("is-hover-mark");
    });
    mark.addEventListener("pointerleave", () => {
      document.querySelectorAll(".is-hover-mark").forEach(item => item.classList.remove("is-hover-mark"));
    });
    layer.append(mark);
  });
}

function highlightPosterMark(index) {
  for (const mark of elements.posterMarks?.children || []) {
    mark.classList.toggle("is-active", index !== null && mark.dataset.markIndex === String(index));
  }
}

function addSession(name) {
  const value = String(name || "").trim().toUpperCase();
  if (value && value !== "---") state.sessions.add(value);
}

const NEW_SESSION = "__nova__";

// Sessão: lista das sessões cadastradas, com "+ Nova sessão…" que vira um campo de texto
function createSessionField(page, movie) {
  // Sessão: menu no mesmo estilo do "…" (o do sistema destoava), com "+ Nova sessão…" no fim
  const container = document.createElement("div");
  container.className = "field session-field";
  const id = `${page.id}-${movie.id}-sessao`;
  const label = document.createElement("label");
  label.htmlFor = id;
  label.textContent = "Sessão";
  const current = movie.sessao.trim().toUpperCase();
  const button = document.createElement("button");
  button.type = "button";
  button.id = id;
  button.className = "session-button";
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");
  const text = document.createElement("span");
  text.textContent = current || "Escolha a sessão";
  text.classList.toggle("is-empty", !current);
  button.append(text);
  button.insertAdjacentHTML("beforeend", '<svg viewBox="0 0 10 6" width="10" height="6" aria-hidden="true"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>');
  button.addEventListener("click", event => {
    event.stopPropagation();
    const open = container.querySelector(".session-menu");
    closeSessionMenus();
    if (!open) openSessionMenu(container, button, movie, current);
  });
  container.append(label, button);
  return container;
}

function closeSessionMenus() {
  for (const menu of document.querySelectorAll(".session-menu")) {
    menu.previousElementSibling?.setAttribute("aria-expanded", "false");
    menu.remove();
  }
}

function openSessionMenu(container, button, movie, current) {
  const menu = document.createElement("div");
  menu.className = "menu-popover session-menu";
  menu.setAttribute("role", "listbox");
  const options = [...new Set([...state.sessions, ...(current ? [current] : [])])].sort((a, b) => a.localeCompare(b, "pt-BR"));
  for (const name of options) {
    const option = document.createElement("button");
    option.type = "button";
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", String(name === current));
    option.textContent = name;
    option.addEventListener("click", () => { closeSessionMenus(); setMovieSession(movie, name); });
    menu.append(option);
  }
  if (options.length) menu.append(document.createElement("hr"));
  const create = document.createElement("button");
  create.type = "button";
  create.className = "session-new";
  create.textContent = "+ Nova sessão…";
  create.addEventListener("click", () => {
    closeSessionMenus();
    const input = document.createElement("input");
    input.type = "text";
    input.id = button.id;
    input.placeholder = "Nome da sessão";
    const done = () => {
      const value = input.value.trim().toUpperCase();
      if (value) { addSession(value); setMovieSession(movie, value); }
      else { renderPageGroup(); }
    };
    input.addEventListener("keydown", event => {
      if (event.key === "Enter") input.blur();
      if (event.key === "Escape") { input.value = ""; input.blur(); }
    });
    input.addEventListener("blur", done, { once: true });
    button.replaceWith(input);
    input.focus();
  });
  menu.append(create);
  button.after(menu);
  button.setAttribute("aria-expanded", "true");
  menu.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
}

function setMovieSession(movie, value) {
  const wasStd = isStd(movie);
  movie.sessao = value;
  state.isDirty = true;
  renderSaveState();
  // redesenha: a sessão nova aparece no botão, e entrar ou sair da Sessão da Tarde muda o filme de lugar
  renderPageGroup();
  renderPosterMarks();
  scheduleCheck();
}

function createTextField(page, movie, field, label, value, type = "text", className = "") {
  const container = document.createElement("div");
  container.className = "field";
  const id = `${page.id}-${movie.id}-${field}`;
  const labelElement = document.createElement("label");
  labelElement.htmlFor = id;
  labelElement.textContent = label;
  const input = createMovieInput(page, movie, field, type);
  input.id = id;
  input.value = value;
  if (className) input.classList.add(className);
  container.append(labelElement, input);
  return container;
}

function createMovieInput(page, movie, field, type) {
  const input = document.createElement("input");
  input.type = type;
  input.dataset.pageId = page.id;
  input.dataset.movieId = movie.id;
  input.dataset.movieField = field;
  return input;
}

function handleGroupClick(event) {
  const navigation = event.target.closest("[data-navigate-page]");
  if (navigation) return navigatePage(Number(navigation.dataset.navigatePage));
  const retry = event.target.closest("[data-retry-page]");
  if (retry) return retryPage(retry.dataset.retryPage);
  const add = event.target.closest("[data-add-movie]");
  if (add) return addMovie(add.dataset.addMovie);
  const remove = event.target.closest("[data-remove-movie]");
  if (remove) return removeMovie(remove.dataset.pageId, remove.dataset.removeMovie);
  const apply = event.target.closest("[data-apply-field]");
  if (apply) return applySuggestion(apply);
  const include = event.target.closest("[data-include-poster]");
  if (include) return includeGhost(include);
  const pick = event.target.closest("[data-pick-poster]");
  if (pick) {
    state.pickingMovieId = state.pickingMovieId === pick.dataset.pickPoster ? null : pick.dataset.pickPoster;
    renderPageGroup();
    renderPosterMarks();
    return;
  }
  const set = event.target.closest("[data-set-poster]");
  if (set) setMoviePoster(set.dataset.setPoster, set.dataset.posterIndex === "" ? null : Number(set.dataset.posterIndex));
}

function handleMovieInput(event) {
  const input = event.target.closest("[data-movie-field]");
  if (!input) return;
  const page = state.pages.find(item => item.id === input.dataset.pageId);
  const movie = page?.movies.find(item => item.id === input.dataset.movieId);
  if (!movie) return;
  movie[input.dataset.movieField] = input.type === "checkbox" ? input.checked : input.value;
  state.isDirty = true;
  renderSaveState();
  scheduleCheck();
}

function addMovie(pageId) {
  const page = state.pages.find(item => item.id === pageId);
  if (!page || page.status !== PAGE_STATUS.SUCCESS) return;
  page.movies.push({ id: createId(), titulo: "", ano_de_producao: "", sessao: "", data: "", inedito: false, poster: null, posterTouched: false });
  state.isDirty = true;
  renderPageGroup();
  renderSaveState();
}

function removeMovie(pageId, movieId) {
  const page = state.pages.find(item => item.id === pageId);
  if (!page) return;
  page.movies = page.movies.filter(movie => movie.id !== movieId);
  state.isDirty = true;
  renderPageGroup();
  renderSaveState();
  scheduleCheck();
}

function retryPage(pageId) {
  const page = state.pages.find(item => item.id === pageId);
  if (!page || page.status !== PAGE_STATUS.ERROR) return;
  page.status = PAGE_STATUS.WAITING;
  page.message = "Aguardando nova tentativa.";
  state.selectedPageNumber = page.originalPageNumber;
  setPhase(APP_PHASE.PROCESSING);
  render();
  startScheduler();
}

function retryAllErrors() {
  const errors = state.pages.filter(page => page.status === PAGE_STATUS.ERROR);
  if (!errors.length) return;
  errors.forEach(page => {
    page.status = PAGE_STATUS.WAITING;
    page.message = "Aguardando nova tentativa.";
  });
  state.selectedPageNumber = errors[0].originalPageNumber;
  setPhase(APP_PHASE.PROCESSING);
  render();
  startScheduler();
}

function cancelWaitingPages() {
  const waiting = state.pages.filter(page => page.status === PAGE_STATUS.WAITING);
  if (!waiting.length || !confirm(`Cancelar ${waiting.length} página(s) pendente(s)?`)) return;
  waiting.forEach(page => {
    page.status = PAGE_STATUS.CANCELLED;
    page.message = "Processamento cancelado.";
  });
  closeMenus();
  updatePhaseFromQueue();
  updateSelectionAfterPageFinished();
  render();
}

function replacePdf() {
  closeMenus();
  if (!hasActivePages()) elements.fileInput.click();
}

function clearProject() {
  if (hasActivePages() || !confirm("Remover o PDF e todos os resultados?")) return;
  clearProjectState();
  closeMenus();
  clearUploadMessages();
  setPhase(APP_PHASE.UPLOAD);
  render();
}

function clearProjectState() {
  state.sourceFile = null;
  state.sourceBytes = null;
  state.pdfDocument = null;
  state.documentId = null;
  for (const page of state.pages) page.images?.posters.forEach(poster => URL.revokeObjectURL(poster.url));
  state.pages = [];
  state.selectedPageNumber = null;
  state.lastDispatchAt = 0;
  state.isSchedulerRunning = false;
  state.isSaving = false;
  state.isDirty = false;
  state.checks.clear();
  state.pickingMovieId = null;
  elements.previewCanvas.getContext("2d").clearRect(
    0, 0, elements.previewCanvas.width, elements.previewCanvas.height
  );
}

async function saveResults() {
  if (!canSave()) return;
  const validationError = validateMovies();
  if (validationError) return showSaveMessage(validationError, "error");
  state.isSaving = true;
  renderSaveState();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CONFIG.SAVE_TIMEOUT_MS);
  let successMessage = null;

  try {
    // A UI fica bloqueada (botão desabilitado via state.isSaving) até o
    // webhook responder — só seguimos adiante depois do await abaixo.
    const response = await fetch(CONFIG.SAVE_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(await buildSavePayload()),
      credentials: "omit",
      signal: controller.signal
    });
    const text = await response.text();
    // Qualquer status fora de 200-299 (500, etc.) cai aqui como erro.
    if (!response.ok) throw new Error(extractErrorMessage(text) || explainHttpError(response, "N8N_SAVE_WEBHOOK_URL"));
    const result = parseSaveResponse(text);
    if (!result.success) throw new Error(result.message || "Não foi possível salvar.");
    state.isDirty = false;
    successMessage = result.message || "Envio para o Trello concluído com sucesso.";
  } catch (error) {
    // Erro (HTTP ou de validação da resposta): avisamos e NÃO tocamos
    // no restante da página — o usuário continua na tela de revisão.
    showSaveMessage(getRequestErrorMessage(error), "error");
  } finally {
    clearTimeout(timeoutId);
    state.isSaving = false;
  }

  if (successMessage) {
    // Sucesso (HTTP 200 com success=true): avisamos o usuário e voltamos
    // para a tela inicial de upload.
    alert(successMessage);
    clearProjectState();
    clearUploadMessages();
    setPhase(APP_PHASE.UPLOAD);
    render();
    return;
  }
  renderSaveState();
}

async function buildSavePayload() {
  const posters = new Map();
  for (const page of state.pages) {
    if (page.status !== PAGE_STATUS.SUCCESS || !page.images) continue;
    for (const movie of page.movies) {
      const poster = page.images.posters[movie.poster];
      if (poster) posters.set(movie.id, await posterDataUrl(poster.blob).catch(() => ""));
    }
  }
  return {
    document_id: state.documentId,
    original_file_name: state.sourceFile.name,
    original_total_pages: state.pdfDocument.numPages,
    saved_at: new Date().toISOString(),
    pages: state.pages
      .filter(page => page.status === PAGE_STATUS.SUCCESS)
      .map(page => ({
        page_number: page.originalPageNumber,
        useful_page_number: page.usefulPageNumber,
        path: page.path,
        status: page.workflowStatus,
        ID: page.responseId,
        movies: page.movies.map(movie => ({
          titulo: movie.titulo.trim(),
          ano_de_producao: movie.ano_de_producao.trim(),
          sessao: movie.sessao.trim(),
          data: movie.data,
          inedito: Boolean(movie.inedito),
          poster: posters.get(movie.id) || ""
        }))
      }))
  };
}

// O pôster vai como JPEG em data URL, com no máximo POSTER_SEND_MAX_HEIGHT de altura.
async function posterDataUrl(blob) {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, CONFIG.POSTER_SEND_MAX_HEIGHT / bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvas.toDataURL("image/jpeg", CONFIG.POSTER_SEND_QUALITY);
}

/* ---------------------------------------------------------
   Conferência: o que o envio vai fazer com cada filme
   --------------------------------------------------------- */

function isCheckEnabled() {
  return CONFIG.CHECK_ON_SAVE_WEBHOOK && Boolean(CONFIG.SAVE_WEBHOOK_URL) && !CONFIG.SAVE_WEBHOOK_URL.includes("****");
}

function scheduleCheck() {
  if (!isCheckEnabled()) return;
  clearTimeout(state.checkTimer);
  state.checkTimer = setTimeout(runCheck, CONFIG.CHECK_DEBOUNCE_MS);
}

function moviesToCheck() {
  return state.pages
    .filter(page => page.status === PAGE_STATUS.SUCCESS)
    .flatMap(page => page.movies.map(movie => ({ page, movie })))
    .filter(({ movie }) => movie.titulo.trim() && movie.sessao.trim() && movie.data);
}

async function runCheck() {
  const list = moviesToCheck();
  const seq = ++state.checkSeq;
  if (!list.length) {
    state.checks.clear();
    return updateCheckViews();
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CONFIG.CHECK_TIMEOUT_MS);
  try {
    const response = await fetch(CONFIG.SAVE_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ acao: "conferir", movies: list.map(({ movie }) => ({
        titulo: movie.titulo.trim(),
        ano_de_producao: movie.ano_de_producao.trim(),
        sessao: movie.sessao.trim(),
        data: movie.data,
        inedito: Boolean(movie.inedito)
      })) }),
      credentials: "omit",
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (seq !== state.checkSeq) return;
    const rows = Array.isArray(data?.movies) ? data.movies : [];
    state.checks.clear();
    for (const row of rows) {
      const item = list[Number(row.ord) - 1];
      if (item) state.checks.set(item.movie.id, row);
    }
  } catch (error) {
    // A conferência é uma ajuda: se falhar, a revisão e o envio seguem normais.
    console.warn("[Conferência]", error);
    if (seq === state.checkSeq) state.checks.clear();
  } finally {
    clearTimeout(timeoutId);
  }
  updateCheckViews();
}

function updateCheckViews() {
  for (const element of document.querySelectorAll("[data-check-for]")) {
    const found = findMovie(element.dataset.checkFor);
    if (found) fillCheck(element, found.page, found.movie);
  }
  renderQueueState(getCounts());
  renderStdSummary();
}

function findMovie(movieId) {
  for (const page of state.pages) {
    const movie = page.movies.find(item => item.id === movieId);
    if (movie) return { page, movie };
  }
  return null;
}

function compact(text) {
  return String(text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/&/g, "e").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function fillCheck(element, page, movie) {
  const row = state.checks.get(movie.id);
  element.replaceChildren();
  element.hidden = !row;
  if (!row) return;
  const chip = (text, tone, title) => {
    const item = document.createElement("span");
    item.className = `check-chip ${tone}`;
    item.textContent = text;
    if (title) item.title = title;
    element.append(item);
    return item;
  };
  const suggest = (label, field, value) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "check-apply";
    button.dataset.pageId = page.id;
    button.dataset.movieId = movie.id;
    button.dataset.applyField = field;
    button.dataset.applyValue = value;
    button.textContent = label;
    element.append(button);
  };

  if (row.card_existente) {
    const item = chip("já tem card", "is-muted", "Este filme já tem card neste dia: o envio não duplica.");
    if (/^https?:/.test(row.card_existente)) {
      const link = document.createElement("a");
      link.href = row.card_existente;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = "já tem card ↗";
      item.replaceChildren(link);
    }
    return;
  }
  if (!row.sessao_ok) chip("sessão sem cadastro", "is-danger", "A sessão não está nas atrações (tipo Sessão de filme).");
  if (row.novo) chip("filme novo", "is-warning", "Entra no acervo de filmes no envio.");
  else {
    chip("no acervo", "is-success", row.filme_titulo || "");
    if (row.filme_titulo && row.filme_titulo !== movie.titulo.trim() && compact(row.filme_titulo) === compact(movie.titulo)) {
      suggest(`usar “${row.filme_titulo}”`, "titulo", row.filme_titulo);
    }
    if (row.ano_diferente && row.ano) {
      chip(`acervo: ${row.ano}`, "is-warning", "O ano do PDF é diferente do ano no acervo.");
      suggest(`usar ${row.ano}`, "ano_de_producao", String(row.ano));
    } else if (!movie.ano_de_producao.trim() && row.ano) {
      suggest(`ano ${row.ano}`, "ano_de_producao", String(row.ano));
    }
  }
  const novas = Array.isArray(row.artes_novas) ? row.artes_novas : [];
  const existentes = Array.isArray(row.artes_existentes) ? row.artes_existentes : [];
  chip(`${novas.length} ${novas.length === 1 ? "arte" : "artes"}`, "is-neutral", novas.join(", "));
  if (existentes.length) chip(`${existentes.length} já ${existentes.length === 1 ? "existe" : "existem"}`, "is-muted", existentes.join(", "));
}

function applySuggestion(button) {
  const found = findMovie(button.dataset.movieId);
  if (!found) return;
  const field = button.dataset.applyField;
  found.movie[field] = button.dataset.applyValue;
  const input = document.querySelector(
    `[data-movie-id="${button.dataset.movieId}"][data-movie-field="${field}"]`
  );
  if (input) input.value = button.dataset.applyValue;
  state.isDirty = true;
  renderSaveState();
  scheduleCheck();
}

function checkSummary() {
  if (!isCheckEnabled() || !state.checks.size) return "";
  const rows = [...state.checks.values()];
  const existing = rows.filter(row => row.card_existente).length;
  const fresh = rows.length - existing;
  const newMovies = rows.filter(row => !row.card_existente && row.novo).length;
  const parts = [`${fresh} ${fresh === 1 ? "card novo" : "cards novos"}`];
  if (existing) parts.push(`${existing} já ${existing === 1 ? "existe" : "existem"}`);
  if (newMovies) parts.push(`${newMovies} ${newMovies === 1 ? "filme novo" : "filmes novos"} no acervo`);
  return parts.join(" · ");
}

function parseSaveResponse(text) {
  // O node "Respond to Webhook" está configurado como "Respond With: No
  // Data" no caminho de sucesso, então a resposta chega com HTTP 200 e
  // corpo vazio. Tratamos isso (e qualquer corpo sem "success": false)
  // como sucesso — já que erros já foram tratados pelo status HTTP
  // fora da faixa 200-299 antes desta função ser chamada.
  const trimmed = text.trim();
  if (!trimmed) return { success: true, message: "" };
  let data;
  try { data = JSON.parse(trimmed); }
  catch { return { success: true, message: "" }; }
  const result = Array.isArray(data) ? data[0] : data;
  if (typeof result?.success === "boolean") {
    return { success: result.success, message: typeof result.message === "string" ? result.message : "" };
  }
  return { success: true, message: typeof result?.message === "string" ? result.message : "" };
}

function validateMovies() {
  for (const page of state.pages) {
    if (page.status !== PAGE_STATUS.SUCCESS) continue;
    for (const movie of page.movies) {
      if (!movie.sessao.trim()) return `Informe a sessão na página ${page.originalPageNumber}.`;
      if (!movie.titulo.trim()) return `Informe o título na página ${page.originalPageNumber}.`;
      if (movie.ano_de_producao && !/^\d{4}$/.test(movie.ano_de_producao)) {
        return `Use quatro dígitos no ano da página ${page.originalPageNumber}.`;
      }
      if (!movie.data && !isStd(movie)) return `Informe a data na página ${page.originalPageNumber}.`;
    }
  }
  return "";
}

function canSave() {
  return state.isDirty && !state.isSaving &&
    state.pages.some(page => page.status === PAGE_STATUS.SUCCESS) &&
    !state.pages.some(page => [PAGE_STATUS.WAITING, PAGE_STATUS.PROCESSING, PAGE_STATUS.ERROR].includes(page.status));
}

function renderSaveState() {
  elements.saveButton.disabled = !canSave();
  if (state.isSaving) {
    elements.saveButton.textContent = "Salvando…";
    return showSaveMessage("Enviando as informações revisadas.", "info");
  }
  elements.saveButton.textContent = state.isDirty ? "Enviar para o Trello" : "Enviado";
  if (!state.pages.length) return hideSaveMessage();
  if (state.pages.some(page => page.status === PAGE_STATUS.ERROR)) {
    return showSaveMessage("Reenvie as páginas com erro antes de salvar.", "error");
  }
  // só os erros aparecem: avisos de rotina ocupavam espaço sem dizer nada novo
  hideSaveMessage();
}

function showSaveMessage(message, type = "info") {
  elements.saveStateMessage.hidden = false;
  elements.saveStateMessage.textContent = message;
  elements.saveStateMessage.className = `save-state-message is-${type}`;
}

function hideSaveMessage() {
  elements.saveStateMessage.hidden = true;
  elements.saveStateMessage.textContent = "";
}

function initializeHealthCheck() {
  checkWorkflowHealth();
  state.healthCheckIntervalId = setInterval(() => {
    if (!document.hidden) checkWorkflowHealth();
  }, CONFIG.HEALTHCHECK_INTERVAL_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) checkWorkflowHealth();
  });
}

async function checkWorkflowHealth() {
  if (state.isHealthCheckRunning) return;
  state.isHealthCheckRunning = true;
  updateConnectionStatus("checking");
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CONFIG.HEALTHCHECK_TIMEOUT_MS);
  try {
    const url = new URL(CONFIG.HEALTHCHECK_URL, window.location.origin);
    url.searchParams.set("_healthcheck", Date.now().toString());
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const result = Array.isArray(data) ? data[0] : data;
    if (result?.online !== true) throw new Error("Healthcheck inválido.");
    updateConnectionStatus("online");
  } catch (error) {
    console.warn("[Healthcheck]", error);
    updateConnectionStatus("offline");
  } finally {
    clearTimeout(timeoutId);
    state.isHealthCheckRunning = false;
  }
}

function updateConnectionStatus(status) {
  const labels = {
    checking: "Verificando...",
    online: "Workflow disponível",
    offline: "Workflow indisponível"
  };
  elements.connectionStatus.classList.remove("is-checking", "is-online", "is-offline");
  elements.connectionStatus.classList.add(`is-${status}`);
  elements.connectionStatusLabel.textContent = labels[status];
}

function initializeTypewriter() {
  const title = document.querySelector(".hero h1");
  if (!title || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const original = title.textContent.trim();
  title.setAttribute("aria-label", original);
  const text = document.createElement("span");
  text.setAttribute("aria-hidden", "true");
  const cursor = document.createElement("span");
  cursor.className = "typewriter-cursor";
  cursor.setAttribute("aria-hidden", "true");
  cursor.textContent = "|";
  title.replaceChildren(text, cursor);
  let index = 0;
  setTimeout(function typeNext() {
    if (index >= original.length) {
      setTimeout(() => title.classList.add("hide-cursor"), 1800);
      return;
    }
    text.textContent += original[index++];
    setTimeout(typeNext, 38 + Math.random() * 28);
  }, 350);
}

/*
 * Faz o highlight radial do fundo da página (o "papel de parede"
 * atrás do card) seguir o cursor — igual ao app de roteiros.
 * Desativado para quem prefere movimento reduzido.
 */
function initializeMouseGradient() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  let frameId = null;
  let lastX = 10;
  let lastY = 5;

  window.addEventListener(
    "pointermove",
    event => {
      if (frameId !== null) return;

      frameId = requestAnimationFrame(() => {
        const x = (event.clientX / window.innerWidth) * 100;
        const y = (event.clientY / window.innerHeight) * 100;

        lastX += (x - lastX) * 0.16;
        lastY += (y - lastY) * 0.16;

        document.body.style.setProperty("--mouse-x", `${lastX.toFixed(2)}%`);
        document.body.style.setProperty("--mouse-y", `${lastY.toFixed(2)}%`);

        frameId = null;
      });
    },
    { passive: true }
  );
}

function hasActivePages() {
  return state.pages.some(page =>
    [PAGE_STATUS.WAITING, PAGE_STATUS.PROCESSING].includes(page.status)
  );
}

// Diz de onde veio o erro: do site sem o worker, de um segredo ou do próprio n8n.
function explainHttpError(response, secret) {
  if (!response.headers.get("x-filmebot-worker")) {
    return `O site está sem o worker (_worker.js) que fala com o n8n (HTTP ${response.status}). Publique de novo com o publicar.sh.`;
  }
  if (response.headers.get("x-filmebot-origem") === "n8n" && response.status === 404) {
    return `O n8n não achou o webhook (HTTP 404): confira a URL no segredo ${secret} (/webhook/, não /webhook-test/) e se o fluxo está ativo.`;
  }
  return `O workflow retornou HTTP ${response.status}.`;
}

function extractErrorMessage(text) {
  if (!text?.trim()) return "";
  try {
    const data = JSON.parse(text);
    const result = Array.isArray(data) ? data[0] : data;
    return typeof result?.message === "string" ? result.message : "";
  } catch { return ""; }
}

function getRequestErrorMessage(error) {
  if (error?.name === "AbortError") return "A requisição excedeu o tempo limite.";
  if (error instanceof TypeError) return "Não foi possível acessar o workflow. Verifique conexão e CORS.";
  return error?.message || "Não foi possível concluir a comunicação com o workflow.";
}

function setUploadBusy(busy) {
  elements.selectFileButton.disabled = busy;
  elements.selectFileButton.textContent = busy ? "Preparando PDF…" : "Selecionar PDF";
}

function showUploadMessage(message, type) {
  const element = document.createElement("p");
  element.className = `validation-message${type === "success" ? " is-success" : ""}`;
  element.textContent = message;
  elements.validationMessages.append(element);
}

function clearUploadMessages() { elements.validationMessages.replaceChildren(); }
function closeMenus() {
  document.querySelectorAll("details[open]").forEach(item => item.removeAttribute("open"));
}
function createId() {
  return crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
function formatAttempts(value) {
  return value === 0 ? "nenhuma tentativa" : value === 1 ? "1 tentativa" : `${value} tentativas`;
}
function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
