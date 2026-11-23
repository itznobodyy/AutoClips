const form = document.querySelector("#form");
const urlInput = document.querySelector("#url");
const analyzeBtn = document.querySelector("#analyze");
const fileInput = document.querySelector("#file-input");
const fileName = document.querySelector("#file-name");
const errorBox = document.querySelector("#error");
const cookiesHint = document.querySelector("#cookies-hint");
const statusBox = document.querySelector("#status");
const barFill = document.querySelector("#bar-fill");
const statusText = document.querySelector("#status-text");
const videoBox = document.querySelector("#video");
const thumb = document.querySelector("#thumb");
const title = document.querySelector("#title");
const uploader = document.querySelector("#uploader");
const frame = document.querySelector("#frame");
const editor = document.querySelector("#editor");
const list = document.querySelector("#segments");
const addBtn = document.querySelector("#add");
const formatSelect = document.querySelector("#format");
const cutBtn = document.querySelector("#cut");
const results = document.querySelector("#results");
const outputs = document.querySelector("#outputs");

let jobId = null;
let videoId = null;
let poll = null;
let maxClips = 6;

fetch("/api/config")
  .then((r) => r.json())
  .then((config) => {
    cookiesHint.hidden = config.cookies && config.pot;
    if (Number(config.maxClips) > 0) maxClips = Number(config.maxClips);
  })
  .catch(() => {});

/* ---- file picker label ---- */
fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  fileName.textContent = file ? file.name : "";
  if (file) {
    urlInput.value = "";
    clearError();
  }
});

urlInput.addEventListener("input", () => {
  if (urlInput.value) {
    fileInput.value = "";
    fileName.textContent = "";
  }
  if (errorBox.textContent) clearError();
});

/* ---- helpers ---- */
function showError(text) { errorBox.textContent = text; }
function clearError() { errorBox.textContent = ""; }

function setProgress(value, text) {
  statusBox.hidden = false;
  barFill.style.width = `${Math.max(0, Math.min(100, value))}%`;
  statusText.textContent = text;
}

function toSeconds(value) {
  const parts = String(value).split(":").map(Number);
  if (parts.some((p) => Number.isNaN(p))) return 0;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

function toClock(value) {
  const total = Math.max(0, Math.floor(value));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function preview(start) {
  if (!videoId || videoId === jobId) return; // uploaded file — no YouTube embed
  frame.innerHTML = "";
  const iframe = document.createElement("iframe");
  iframe.src = `https://www.youtube-nocookie.com/embed/${videoId}?start=${Math.floor(start)}&autoplay=1`;
  iframe.allow = "autoplay; encrypted-media; picture-in-picture";
  iframe.allowFullscreen = true;
  iframe.title = "Vista previa del corte";
  frame.append(iframe);
}

function addRow(segment) {
  if (list.children.length >= maxClips) {
    showError(`Máximo ${maxClips} cortes por video.`);
    return;
  }

  const li = document.createElement("li");
  li.className = "segment";

  const check = document.createElement("input");
  check.type = "checkbox";
  check.checked = true;
  check.setAttribute("aria-label", "Incluir este corte");
  check.addEventListener("change", () => li.classList.toggle("off", !check.checked));

  const img = document.createElement("img");
  img.alt = "";
  img.loading = "lazy";
  if (segment.thumb) img.src = segment.thumb;

  const times = document.createElement("div");
  times.className = "times";

  const start = document.createElement("input");
  start.value = toClock(segment.start);
  start.inputMode = "numeric";
  start.setAttribute("aria-label", "Segundo de inicio");

  const arrow = document.createElement("span");
  arrow.textContent = "→";

  const end = document.createElement("input");
  end.value = toClock(segment.end);
  end.inputMode = "numeric";
  end.setAttribute("aria-label", "Segundo de fin");

  times.append(start, arrow, end);

  const actions = document.createElement("div");
  actions.className = "row-actions";

  const play = document.createElement("button");
  play.type = "button";
  play.className = "ghost";
  play.textContent = "Ver";
  play.addEventListener("click", () => preview(toSeconds(start.value)));

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "ghost";
  remove.textContent = "✕";
  remove.setAttribute("aria-label", "Quitar corte");
  remove.addEventListener("click", () => li.remove());

  actions.append(play, remove);
  li.append(check, img, times, actions);
  list.append(li);
}

function resetView() {
  clearError();
  clearInterval(poll);
  poll = null;
  editor.hidden = true;
  results.hidden = true;
  statusBox.hidden = true;
  barFill.style.width = "0%";
  outputs.innerHTML = "";
  list.innerHTML = "";
  frame.innerHTML = "";
  videoBox.hidden = true;
  videoId = null;
  jobId = null;
  cutBtn.disabled = false;
}

/* ---- URL submit ---- */
form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const file = fileInput.files[0];
  const url = urlInput.value.trim();

  if (!file && !url) {
    showError("Pega un enlace o selecciona un archivo de video.");
    return;
  }

  resetView();
  analyzeBtn.disabled = true;

  if (file) {
    await submitFile(file);
  } else {
    await submitUrl(url);
  }
});

async function submitUrl(url) {
  setProgress(2, "Enviando…");
  try {
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "No se pudo analizar el enlace.");
    jobId = data.jobId;
    if (data.position > 1) setProgress(3, `En cola · posición ${data.position}`);
    poll = setInterval(check, 1300);
  } catch (err) {
    statusBox.hidden = true;
    showError(err.message);
    analyzeBtn.disabled = false;
  }
}

async function submitFile(file) {
  setProgress(2, "Subiendo archivo…");

  const formData = new FormData();
  formData.append("video", file);

  try {
    // Track upload progress with XHR so the bar moves during the transfer
    const data = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/upload");
      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 90);
          setProgress(pct, `Subiendo… ${pct}%`);
        }
      });
      xhr.addEventListener("load", () => {
        try {
          const json = JSON.parse(xhr.responseText);
          if (xhr.status >= 400) reject(new Error(json.error || "Error al subir el archivo."));
          else resolve(json);
        } catch {
          reject(new Error("Respuesta inesperada del servidor."));
        }
      });
      xhr.addEventListener("error", () => reject(new Error("No se pudo conectar con el servidor.")));
      xhr.send(formData);
    });

    jobId = data.jobId;
    if (data.position > 1) setProgress(91, `En cola · posición ${data.position}`);
    poll = setInterval(check, 1300);
  } catch (err) {
    statusBox.hidden = true;
    showError(err.message);
    analyzeBtn.disabled = false;
  }
}

/* ---- polling ---- */
async function check() {
  try {
    const res = await fetch(`/api/jobs/${jobId}`);
    if (res.status === 404) {
      clearInterval(poll);
      statusBox.hidden = true;
      showError("El trabajo caducó. Vuelve a analizar.");
      analyzeBtn.disabled = false;
      return;
    }

    const job = await res.json();

    if (job.status === "queued" && job.position > 0) {
      setProgress(3, `En cola · posición ${job.position}`);
      return;
    }

    if (job.status === "working" || job.status === "cutting") {
      setProgress(job.progress, job.message || "Procesando…");
    }

    if (job.meta && !videoId) {
      // For YouTube jobs the id is an 11-char video id; for uploads it's the job UUID
      videoId = job.meta.id;
      const isYouTube = /^[A-Za-z0-9_-]{11}$/.test(videoId);
      thumb.src = isYouTube
        ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
        : "";
      thumb.hidden = !isYouTube;
      title.textContent = job.meta.title;
      uploader.textContent = job.meta.uploader || "";
      videoBox.hidden = false;
    }

    if (job.status === "ready") {
      clearInterval(poll);
      analyzeBtn.disabled = false;
      setProgress(100, job.message);
      for (const segment of job.segments || []) addRow(segment);
      editor.hidden = false;
    }

    if (job.status === "error") {
      clearInterval(poll);
      analyzeBtn.disabled = false;
      cutBtn.disabled = false;
      statusBox.hidden = true;
      showError(job.message || "Ocurrió un error.");
    }

    if (job.status === "done") {
      clearInterval(poll);
      cutBtn.disabled = false;
      setProgress(100, job.message);
      outputs.innerHTML = "";
      for (const item of job.outputs || []) {
        const li = document.createElement("li");
        const link = document.createElement("a");
        link.href = item.url;
        link.download = item.file;

        const name = document.createElement("span");
        name.textContent = item.file;

        const meta = document.createElement("span");
        meta.textContent = `${toClock(item.start)} → ${toClock(item.end)} · ${Math.round(item.size / 1024)} KB ↓`;

        link.append(name, meta);
        li.append(link);
        outputs.append(li);
      }
      results.hidden = false;
    }
  } catch {
    clearInterval(poll);
    statusBox.hidden = true;
    analyzeBtn.disabled = false;
    showError("Se perdió la conexión con el servidor.");
  }
}

/* ---- manual cut row ---- */
addBtn.addEventListener("click", () => {
  if (!jobId) return;
  clearError();
  addRow({ start: 0, end: 20, thumb: null });
});

/* ---- generate clips ---- */
cutBtn.addEventListener("click", async () => {
  clearError();

  const segments = [...list.querySelectorAll(".segment")]
    .map((li) => {
      const check = li.querySelector('input[type="checkbox"]');
      const [start, end] = li.querySelectorAll(".times input");
      return {
        checked: check?.checked ?? false,
        start: toSeconds(start?.value ?? "0"),
        end: toSeconds(end?.value ?? "0"),
      };
    })
    .filter((s) => s.checked && s.end - s.start >= 1)
    .map(({ start, end }) => ({ start, end }));

  if (!segments.length) {
    showError("Marca al menos un corte válido de 1 segundo o más.");
    return;
  }

  cutBtn.disabled = true;
  setProgress(1, "Enviando cortes…");

  try {
    const res = await fetch(`/api/jobs/${jobId}/cut`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ segments, format: formatSelect.value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "No se pudo iniciar el corte.");
    poll = setInterval(check, 1500);
  } catch (err) {
    statusBox.hidden = true;
    showError(err.message);
    cutBtn.disabled = false;
  }
});
