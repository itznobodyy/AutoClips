const form = document.querySelector("#form");
const urlInput = document.querySelector("#url");
const analyzeBtn = document.querySelector("#analyze");
const errorBox = document.querySelector("#error");
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

function showError(text) {
  errorBox.textContent = text;
}

function setProgress(value, text) {
  statusBox.hidden = false;
  barFill.style.width = `${value}%`;
  statusText.textContent = text;
}

function toSeconds(value) {
  const parts = String(value).split(":").map(Number);
  if (parts.some(Number.isNaN)) return 0;
  return parts.reduce((acc, part) => acc * 60 + part, 0);
}

function toClock(value) {
  const total = Math.max(0, Math.floor(value));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function preview(start) {
  frame.innerHTML = "";
  const iframe = document.createElement("iframe");
  iframe.src = `https://www.youtube-nocookie.com/embed/${videoId}?start=${Math.floor(start)}&autoplay=1`;
  iframe.allow = "autoplay; encrypted-media; picture-in-picture";
  iframe.allowFullscreen = true;
  frame.append(iframe);
}

function addRow(segment) {
  const li = document.createElement("li");
  li.className = "segment";

  const check = document.createElement("input");
  check.type = "checkbox";
  check.checked = true;

  const img = document.createElement("img");
  if (segment.thumb) img.src = segment.thumb;

  const times = document.createElement("div");
  times.className = "times";

  const start = document.createElement("input");
  start.value = toClock(segment.start);
  start.setAttribute("aria-label", "Inicio");

  const end = document.createElement("input");
  end.value = toClock(segment.end);
  end.setAttribute("aria-label", "Fin");

  times.append(start, "→", end);

  const actions = document.createElement("div");
  actions.className = "row-actions";

  const play = document.createElement("button");
  play.type = "button";
  play.className = "ghost";
  play.textContent = "Ver";
  play.onclick = () => preview(toSeconds(start.value));

  const del = document.createElement("button");
  del.type = "button";
  del.className = "ghost";
  del.textContent = "✕";
  del.onclick = () => li.remove();

  actions.append(play, del);
  li.append(check, img, times, actions);
  li.dataset.check = "1";

  list.append(li);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  showError("");
  editor.hidden = true;
  results.hidden = true;
  outputs.innerHTML = "";
  list.innerHTML = "";
  analyzeBtn.disabled = true;
  setProgress(2, "Enviando…");

  try {
    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: urlInput.value }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Error al analizar.");

    jobId = data.jobId;
    poll = setInterval(check, 1200);
  } catch (err) {
    showError(err.message);
    analyzeBtn.disabled = false;
  }
});

async function check() {
  try {
    const response = await fetch(`/api/jobs/${jobId}`);
    const job = await response.json();

    setProgress(job.progress, job.message);

    if (job.meta && !videoId) {
      videoId = job.meta.id;
      thumb.src = job.meta.thumbnail;
      title.textContent = job.meta.title;
      uploader.textContent = job.meta.uploader;
      videoBox.hidden = false;
    }

    if (job.status === "ready") {
      clearInterval(poll);
      analyzeBtn.disabled = false;
      for (const segment of job.segments) addRow(segment);
      editor.hidden = false;
    }

    if (job.status === "error") {
      clearInterval(poll);
      analyzeBtn.disabled = false;
      showError(job.message);
    }

    if (job.status === "done") {
      clearInterval(poll);
      cutBtn.disabled = false;
      setProgress(100, job.message);
      outputs.innerHTML = "";
      for (const item of job.outputs) {
        const li = document.createElement("li");
        const a = document.createElement("a");
        a.href = item.url;
        a.download = item.file;
        a.innerHTML = `<span>${item.file}</span><span>${toClock(item.start)} → ${toClock(item.end)} · ${Math.round(item.size / 1024)} KB ↓</span>`;
        li.append(a);
        outputs.append(li);
      }
      results.hidden = false;
    }

    if (job.status === "error" && job.outputs?.length) cutBtn.disabled = false;
  } catch {
    clearInterval(poll);
    analyzeBtn.disabled = false;
    showError("Se perdió la conexión con el servidor.");
  }
}

addBtn.addEventListener("click", () => {
  if (!videoId) return;
  addRow({ start: 0, end: 20, thumb: null });
});

cutBtn.addEventListener("click", async () => {
  const segments = [...list.querySelectorAll(".segment")]
    .map((li) => {
      const inputs = li.querySelectorAll("input");
      return {
        start: toSeconds(inputs[1].value),
        end: toSeconds(inputs[2].value),
        checked: inputs[0].checked,
      };
    })
    .filter((s) => s.checked && s.end - s.start >= 1)
    .map(({ start, end }) => ({ start, end }));

  if (!segments.length) return showError("Marca al menos un corte válido de 1 segundo o más.");

  showError("");
  cutBtn.disabled = true;
  setProgress(1, "Cortando…");

  try {
    const response = await fetch(`/api/jobs/${jobId}/cut`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ segments, format: formatSelect.value }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Error al cortar.");
    poll = setInterval(check, 1500);
  } catch (err) {
    showError(err.message);
    cutBtn.disabled = false;
  }
});