"use strict";

if (!window.pdfjsLib) throw new Error("PDF.js não foi carregado.");
if (!window.PDFLib) throw new Error("pdf-lib não foi carregada.");

const pdfjsLib = window.pdfjsLib;
const PDFLib = window.PDFLib;
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const CONFIG = Object.freeze({
  PROCESS_WEBHOOK_URL: "/api/process",
  SAVE_WEBHOOK_URL: "/api/save",
  HEALTHCHECK_URL: "/api/healthcheck",

  FILE_FIELD_NAME: "page",
  SEND_INTERVAL_MS: 2500,
  PROCESS_TIMEOUT_MS: 240000,
  SAVE_TIMEOUT_MS: 60000,
  HEALTHCHECK_INTERVAL_MS: 30000,
  HEALTHCHECK_TIMEOUT_MS: 5000,
  MAX_FILE_SIZE_BYTES: 50 * 1024 * 1024
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
  previewRenderTask: null
};

let previewResizeTimer = null;

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
  previewCanvas: document.querySelector("#preview-canvas"),
  previewLoading: document.querySelector("#preview-loading"),
  scanOverlay: document.querySelector("#scan-overlay"),
  scanMessageLabel: document.querySelector("#scan-message-label"),
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
  initializeHealthCheck();
  elements.uploadLimit.textContent =
    `PDF · Limite de ${formatBytes(CONFIG.MAX_FILE_SIZE_BYTES)}`;
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

  window.addEventListener("resize", handlePreviewResize, { passive: true });
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

  const selectedPage = getSelectedPage();
  elements.previewPageLabel.textContent = `Página ${state.selectedPageNumber}`;
  elements.previewLoading.hidden = false;

  if (state.previewRenderTask) {
    try { state.previewRenderTask.cancel(); } catch { }
  }

  try {
    const pdfPage = await state.pdfDocument.getPage(state.selectedPageNumber);
    const availableWidth = Math.max(320, elements.previewStage.clientWidth - 20);
    const availableHeight = Math.max(200, elements.previewStage.clientHeight - 20);
    const base = pdfPage.getViewport({ scale: 1 });
    const scale = Math.min(
      availableWidth / base.width,
      availableHeight / base.height
    );
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
    await state.previewRenderTask.promise;
    animatePreviewCanvas();
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
  if (!page) {
    elements.scanOverlay.hidden = true;
    elements.previewStatusMessage.textContent = "";
    return;
  }
  // A animação de scanner deve continuar enquanto houver qualquer página
  // aguardando ou em processamento — ela só para quando tudo terminar,
  // e não simplesmente quando a página exibida no momento é concluída.
  const stillProcessing = hasActivePages();
  elements.scanOverlay.hidden = !stillProcessing;
  if (stillProcessing) {
    elements.scanMessageLabel.textContent = page.status === PAGE_STATUS.PROCESSING
      ? `Lendo página ${page.originalPageNumber}…`
      : "Aguardando o processamento continuar…";
  }
  elements.previewStatusMessage.textContent = page.message;
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

    const response = await fetch(CONFIG.PROCESS_WEBHOOK_URL, {
      method: "POST",
      body: formData,
      credentials: "omit",
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(extractErrorMessage(text) || `O workflow retornou HTTP ${response.status}.`);
    }

    const result = parsePageResponse(text);
    page.path = result.path;
    page.workflowStatus = result.status;
    page.responseId = result.ID;
    page.movies = result.movies.map(normalizeMovie);
    page.status = PAGE_STATUS.SUCCESS;
    page.message = `${page.movies.length} filme(s) identificado(s).`;
    state.isDirty = true;
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
    movies: result.movies
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
    inedito: movie?.inedito === true
  };
}

function render() {
  const counts = getCounts();
  renderProgress(counts);
  renderQueueState(counts);
  renderControls(counts);
  renderPageGroup();
  renderSaveState();
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
  else elements.queueStateMessage.textContent = "Todas as páginas disponíveis foram finalizadas.";
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
  meta.textContent = `Página útil ${page.usefulPageNumber} · ${formatAttempts(page.attempts)}`;
  title.append(name, meta);
  nav.append(previous, title, next);
  const actions = document.createElement("div");
  actions.className = "page-group-actions";
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
  group.append(message);

  if (page.status === PAGE_STATUS.SUCCESS) {
    const grid = document.createElement("div");
    grid.className = "movie-grid";
    grid.append(...page.movies.map(movie => createMovieCard(page, movie)));
    group.append(grid);
    const addContainer = document.createElement("div");
    addContainer.className = "add-movie-container";
    const add = document.createElement("button");
    add.type = "button";
    add.className = "add-movie-button";
    add.dataset.addMovie = page.id;
    add.textContent = "+ Adicionar filme";
    addContainer.append(add);
    group.append(addContainer);
  }
  return group;
}

function createNavigationButton(label, direction, ariaLabel) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "page-navigation-button";
  button.dataset.navigatePage = String(direction);
  button.setAttribute("aria-label", ariaLabel);
  button.textContent = label;
  return button;
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

  const top = document.createElement("div");
  top.className = "movie-top-row";
  const session = createTextField(page, movie, "sessao", "Sessão", movie.sessao);
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
  const date = createTextField(page, movie, "data", "Data de exibição", movie.data, "date");
  bottom.append(year, date);
  card.append(remove, top, title, bottom);
  return card;
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
  if (remove) removeMovie(remove.dataset.pageId, remove.dataset.removeMovie);
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
}

function addMovie(pageId) {
  const page = state.pages.find(item => item.id === pageId);
  if (!page || page.status !== PAGE_STATUS.SUCCESS) return;
  page.movies.push({ id: createId(), titulo: "", ano_de_producao: "", sessao: "", data: "", inedito: false });
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
  state.pages = [];
  state.selectedPageNumber = null;
  state.lastDispatchAt = 0;
  state.isSchedulerRunning = false;
  state.isSaving = false;
  state.isDirty = false;
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
      body: JSON.stringify(buildSavePayload()),
      credentials: "omit",
      signal: controller.signal
    });
    const text = await response.text();
    // Qualquer status fora de 200-299 (500, etc.) cai aqui como erro.
    if (!response.ok) throw new Error(extractErrorMessage(text) || `HTTP ${response.status}`);
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

function buildSavePayload() {
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
          inedito: Boolean(movie.inedito)
        }))
      }))
  };
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
      if (!movie.data) return `Informe a data na página ${page.originalPageNumber}.`;
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
  if (!state.isDirty) return showSaveMessage("Todas as alterações estão salvas.", "success");
  showSaveMessage("Revise os filmes e salve as alterações.", "info");
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

function hasActivePages() {
  return state.pages.some(page =>
    [PAGE_STATUS.WAITING, PAGE_STATUS.PROCESSING].includes(page.status)
  );
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
