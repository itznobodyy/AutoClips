import express from "express";
import multer from "multer";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const WORK = path.join(root, "work");
const CLIPS = path.join(root, "clips");
const UPLOADS = path.join(root, "uploads");

const MAX_UPLOAD_BYTES = (Number(process.env.MAX_UPLOAD_GB) || 2) * 1024 ** 3;
const ALLOWED_VIDEO_MIME = new Set([
  "video/mp4", "video/quicktime", "video/x-matroska", "video/webm",
  "video/avi", "video/x-msvideo", "video/mpeg", "video/x-ms-wmv",
  "video/3gpp", "video/x-flv",
]);

const PORT = Number(process.env.PORT) || 8080;
const MAX_JOBS = Math.max(1, Number(process.env.MAX_JOBS) || 1);
const MAX_DURATION = (Number(process.env.MAX_DURATION_MIN) || 90) * 60;
const MAX_CLIPS = Math.max(1, Number(process.env.MAX_CLIPS) || 6);
const MAX_CLIPS_BYTES = (Number(process.env.MAX_CLIPS_GB) || 5) * 1024 ** 3;
const MAX_CLIP_SECONDS = 180;
const JOB_TTL = (Number(process.env.JOB_TTL_MIN) || 120) * 60 * 1000;
const COOKIES_FILE = process.env.COOKIES_FILE || path.join(root, "cookies.txt");
const COOKIES_BROWSER = process.env.COOKIES_BROWSER || "";
const POT_URL = process.env.POT_URL || "";
const YTDLP_PROXY = process.env.YTDLP_PROXY || "";

const FORMAT =
  "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/b";

const jobs = new Map();
const queue = [];
const hits = new Map();
let active = 0;
let shuttingDown = false;

await fs.mkdir(WORK, { recursive: true });
await fs.mkdir(CLIPS, { recursive: true });
await fs.mkdir(UPLOADS, { recursive: true });

/* ---------- helpers ---------- */

function run(cmd, args, { onData, timeout = 0 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timer;

    if (timeout) timer = setTimeout(() => child.kill("SIGKILL"), timeout);

    child.stdout.on("data", (d) => {
      stdout += d;
      onData?.(d.toString());
    });
    child.stderr.on("data", (d) => {
      stderr += d;
      onData?.(d.toString());
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function lastError(stderr) {
  const lines = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  const err = lines.find((l) => /^ERROR/i.test(l)) || lines.at(-1) || "";
  return err.replace(/^ERROR:\s*/i, "").slice(0, 300);
}

function friendly(text) {
  if (/not a bot|Sign in to confirm/i.test(text)) {
    return "YouTube pidió verificación anti-bot. Revisa que el proveedor de PO tokens y el cookies.txt estén activos.";
  }
  if (/private video/i.test(text)) return "El video es privado.";
  if (/age|confirm your age/i.test(text)) return "El video tiene restricción de edad; requiere cookies de una cuenta verificada.";
  if (/unavailable|does not exist/i.test(text)) return "El video no está disponible en esta región o fue borrado.";
  return text;
}

function canonicalUrl(value) {
  try {
    const raw = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`;
    const url = new URL(raw);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (!["youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"].includes(host)) return null;

    let id;
    if (host === "youtu.be") id = url.pathname.split("/").filter(Boolean)[0];
    else if (/^\/watch\/?$/.test(url.pathname)) id = url.searchParams.get("v");
    else id = url.pathname.match(/^\/(?:live|shorts|embed|v)\/([^/?]+)/i)?.[1];

    return id && /^[A-Za-z0-9_-]{11}$/.test(id)
      ? `https://www.youtube.com/watch?v=${id}`
      : null;
  } catch {
    return null;
  }
}

function isUuid(value) {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
}

async function cookieArgs() {
  try {
    const stat = await fs.stat(COOKIES_FILE);
    if (stat.isFile()) return ["--cookies", COOKIES_FILE];
  } catch {}
  return COOKIES_BROWSER ? ["--cookies-from-browser", COOKIES_BROWSER] : [];
}

async function ytArgs() {
  const args = [
    "--no-warnings",
    "--no-playlist",
    "--no-progress",
    "--retries", "5",
    "--fragment-retries", "10",
    "--socket-timeout", "25",
    "--concurrent-fragments", "4",
    "--extractor-args", "youtube:player_client=default,tv",
  ];
  if (POT_URL) args.push("--extractor-args", `youtubepot-bgutilhttp:base_url=${POT_URL}`);
  if (YTDLP_PROXY) args.push("--proxy", YTDLP_PROXY);
  args.push(...(await cookieArgs()));
  return args;
}

function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip;
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length >= max) {
      return res.status(429).json({ error: "Demasiadas peticiones. Espera un momento." });
    }
    list.push(now);
    hits.set(key, list);
    next();
  };
}

function pump() {
  while (active < MAX_JOBS && queue.length && !shuttingDown) {
    const task = queue.shift();
    active += 1;
    Promise.resolve()
      .then(() => task.run())
      .then(task.resolve, task.reject)
      .finally(() => {
        active -= 1;
        pump();
      });
  }
}

function enqueue(task) {
  return new Promise((resolve, reject) => {
    queue.push({ ...task, resolve, reject });
    pump();
  });
}

function queuePosition(job) {
  return queue.findIndex((t) => t.jobId === job.id) + 1;
}

async function saveJob(job) {
  const { dir, ...data } = job;
  await fs.writeFile(path.join(job.dir, "job.json"), JSON.stringify(data)).catch(() => {});
}

/* ---------- multer ---------- */

const upload = multer({
  dest: UPLOADS,
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter(_req, file, cb) {
    const ok = ALLOWED_VIDEO_MIME.has(file.mimetype);
    cb(ok ? null : new Error("Formato de archivo no admitido."), ok);
  },
});


async function loadJob(id) {
  if (!isUuid(id)) return null;
  try {
    const raw = await fs.readFile(path.join(WORK, id, "job.json"), "utf8");
    const data = JSON.parse(raw);
    return { ...data, dir: path.join(WORK, id) };
  } catch {
    return null;
  }
}

async function enforceDiskQuota() {
  let total = 0;
  const entries = [];
  for (const name of await fs.readdir(CLIPS).catch(() => [])) {
    const stat = await fs.stat(path.join(CLIPS, name)).catch(() => null);
    if (!stat?.isFile()) continue;
    total += stat.size;
    entries.push({ name, size: stat.size, mtime: stat.mtimeMs });
  }
  if (total <= MAX_CLIPS_BYTES) return;
  entries.sort((a, b) => a.mtime - b.mtime);
  for (const entry of entries) {
    if (total <= MAX_CLIPS_BYTES) break;
    await fs.rm(path.join(CLIPS, entry.name), { force: true }).catch(() => {});
    total -= entry.size;
  }
}

/* ---------- análisis ---------- */

function buildSegments(duration, silences, target = 30, min = 15, max = 50) {
  const points = [];
  for (const s of silences) {
    if (s.start > 0) points.push((s.start + (s.end ?? duration)) / 2);
  }

  const segments = [];
  let cursor = 0;

  while (duration - cursor > 2) {
    const remaining = duration - cursor;
    let end;

    if (remaining <= max) {
      end = duration;
    } else {
      const want = cursor + target;
      const options = points.filter((p) => p >= cursor + min && p <= cursor + max);
      end = options.length
        ? options.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a))
        : want;
    }

    if (end - cursor < 3) break;
    segments.push({ start: cursor, end });
    cursor = end;
  }

  return segments.slice(0, MAX_CLIPS);
}

async function makeThumb(source, at, dir, index) {
  const out = path.join(dir, `thumb-${index}.jpg`);
  const result = await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-ss", String(at), "-i", source,
    "-frames:v", "1", "-vf", "scale=360:-2", out,
  ], { timeout: 30_000 });
  return result.code === 0;
}

async function analyzeJob(job, url) {
  await fs.mkdir(job.dir, { recursive: true });
  job.status = "working";
  job.message = "Leyendo el video…";
  await saveJob(job);

  const meta = await run("yt-dlp", ["-J", ...(await ytArgs()), url], { timeout: 90_000 });
  if (meta.code !== 0) throw new Error(friendly(lastError(meta.stderr)) || "No se pudo leer el video.");

  const info = JSON.parse(meta.stdout);
  if (info.is_live) throw new Error("Es un directo en curso. Espera a que termine.");
  if (!info.duration) throw new Error("El video no tiene duración utilizable.");
  if (info.duration > MAX_DURATION) {
    throw new Error(`El video dura más de ${Math.round(MAX_DURATION / 60)} minutos.`);
  }

  job.meta = {
    id: info.id,
    title: info.title,
    uploader: info.uploader,
    duration: info.duration,
  };
  await saveJob(job);

  job.message = "Descargando…";
  const dl = await run("yt-dlp", [
    "-f", FORMAT,
    "--merge-output-format", "mp4",
    ...(await ytArgs()),
    "-o", path.join(job.dir, "source.%(ext)s"),
    url,
  ], {
    timeout: 25 * 60 * 1000,
    onData: (text) => {
      const m = text.match(/\[download\]\s+([\d.]+)%/);
      if (m) {
        job.progress = Number(m[1]);
        job.message = `Descargando ${m[1]}%`;
      }
    },
  });
  if (dl.code !== 0) throw new Error(friendly(lastError(dl.stderr)) || "Falló la descarga.");

  const name = (await fs.readdir(job.dir)).find((f) => f.startsWith("source."));
  if (!name) throw new Error("No se encontró el archivo descargado.");
  job.source = path.join(job.dir, name);

  job.message = "Analizando el audio…";
  const probe = await run("ffprobe", [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=nw=1:nk=1", job.source,
  ], { timeout: 30_000 });
  const duration = Number(probe.stdout.trim()) || job.meta.duration;

  const silences = [];
  await run("ffmpeg", [
    "-hide_banner", "-i", job.source,
    "-af", "silencedetect=noise=-32dB:d=0.4",
    "-f", "null", "-",
  ], {
    timeout: 15 * 60 * 1000,
    onData: (text) => {
      const s = text.match(/silence_start:\s*(-?[\d.]+)/);
      const e = text.match(/silence_end:\s*([\d.]+)/);
      if (s) silences.push({ start: Math.max(0, Number(s[1])) });
      if (e && silences.length) silences.at(-1).end = Number(e[1]);
    },
  });

  const raw = buildSegments(duration, silences);
  const segments = [];

  for (let i = 0; i < raw.length; i++) {
    const seg = raw[i];
    const ok = await makeThumb(job.source, (seg.start + seg.end) / 2, job.dir, i);
    segments.push({
      start: Math.round(seg.start * 10) / 10,
      end: Math.round(seg.end * 10) / 10,
      thumb: ok ? `/api/jobs/${job.id}/thumb/${i}` : null,
    });
    job.progress = Math.round(((i + 1) / raw.length) * 100);
  }

  job.segments = segments;
  job.status = "ready";
  job.progress = 100;
  job.message = `${segments.length} cortes sugeridos`;
  await saveJob(job);
}

async function analyzeFileJob(job, uploadPath, originalName) {
  await fs.mkdir(job.dir, { recursive: true });
  job.status = "working";
  job.message = "Moviendo el archivo…";
  await saveJob(job);

  const ext = path.extname(originalName).toLowerCase() || ".mp4";
  const dest = path.join(job.dir, `source${ext}`);
  await fs.rename(uploadPath, dest);
  job.source = dest;

  job.message = "Leyendo el video…";
  const probe = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration:format_tags=title",
    "-of", "json",
    dest,
  ], { timeout: 30_000 });

  if (probe.code !== 0) throw new Error("No se pudo leer el archivo de video.");

  let duration = 0;
  let title = path.basename(originalName, ext);
  try {
    const info = JSON.parse(probe.stdout);
    duration = Number(info?.format?.duration) || 0;
    title = info?.format?.tags?.title || title;
  } catch {}

  if (!duration) throw new Error("El archivo no tiene duración utilizable.");
  if (duration > MAX_DURATION) {
    throw new Error(`El video dura más de ${Math.round(MAX_DURATION / 60)} minutos.`);
  }

  job.meta = { id: job.id, title, uploader: "Archivo local", duration };
  await saveJob(job);

  job.message = "Analizando el audio…";
  const silences = [];
  await run("ffmpeg", [
    "-hide_banner", "-i", dest,
    "-af", "silencedetect=noise=-32dB:d=0.4",
    "-f", "null", "-",
  ], {
    timeout: 15 * 60 * 1000,
    onData: (text) => {
      const s = text.match(/silence_start:\s*(-?[\d.]+)/);
      const e = text.match(/silence_end:\s*([\d.]+)/);
      if (s) silences.push({ start: Math.max(0, Number(s[1])) });
      if (e && silences.length) silences.at(-1).end = Number(e[1]);
    },
  });

  const raw = buildSegments(duration, silences);
  const segments = [];

  for (let i = 0; i < raw.length; i++) {
    const seg = raw[i];
    const ok = await makeThumb(dest, (seg.start + seg.end) / 2, job.dir, i);
    segments.push({
      start: Math.round(seg.start * 10) / 10,
      end: Math.round(seg.end * 10) / 10,
      thumb: ok ? `/api/jobs/${job.id}/thumb/${i}` : null,
    });
    job.progress = Math.round(((i + 1) / raw.length) * 100);
  }

  job.segments = segments;
  job.status = "ready";
  job.progress = 100;
  job.message = `${segments.length} cortes sugeridos`;
  await saveJob(job);
}

/* ---------- corte ---------- */

function filterFor(format) {
  if (format === "vertical-crop") return { vf: "scale=-2:1920,crop=1080:1920" };
  if (format === "vertical-blur") {
    return {
      complex:
        "[0:v]split=2[bg][fg];" +
        "[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:2[bgb];" +
        "[fg]scale=1080:-2[fgs];" +
        "[bgb][fgs]overlay=(W-w)/2:(H-h)/2[v]",
    };
  }
  return {};
}

function slug(text) {
  return (text || "clip")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "clip";
}

async function cutJob(job, segments, format) {
  const filter = filterFor(format);
  job.outputs = [];
  job.status = "cutting";
  await saveJob(job);

  try {
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      job.progress = Math.round((i / segments.length) * 100);
      job.message = `Cortando ${i + 1} de ${segments.length}…`;
      await saveJob(job);

      const file = `${slug(job.meta.title)}-${job.id.slice(0, 6)}-${i + 1}.mp4`;
      const out = path.join(CLIPS, file);

      const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", job.source,
        "-ss", String(seg.start), "-t", String(seg.end - seg.start)];

      if (filter.complex) args.push("-filter_complex", filter.complex, "-map", "[v]", "-map", "0:a?");
      else if (filter.vf) args.push("-vf", filter.vf, "-map", "0:v:0", "-map", "0:a?");
      else args.push("-map", "0:v:0", "-map", "0:a?");

      args.push(
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "21",
        "-maxrate", "6M", "-bufsize", "12M",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k",
        "-movflags", "+faststart", out,
      );

      const result = await run("ffmpeg", args, { timeout: 10 * 60 * 1000 });
      if (result.code !== 0) throw new Error(lastError(result.stderr) || `Falló el corte ${i + 1}.`);

      job.outputs.push({
        file,
        url: `/clips/${encodeURIComponent(file)}`,
        start: seg.start,
        end: seg.end,
        size: (await fs.stat(out)).size,
      });
    }

    job.status = "done";
    job.progress = 100;
    job.message = `${job.outputs.length} clips listos`;
    await saveJob(job);
    await enforceDiskQuota();
  } catch (err) {
    job.status = "error";
    job.message = err.message;
    await saveJob(job);
  }
}

/* ---------- app ---------- */

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' https://fonts.googleapis.com",
      "font-src https://fonts.gstatic.com",
      "img-src 'self' https://i.ytimg.com data:",
      "frame-src https://www.youtube-nocookie.com",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
    ].join("; "),
  );
  next();
});

app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(root, "public"), { maxAge: "1h" }));

app.get("/healthz", (_req, res) => {
  res.json({ ok: !shuttingDown, active, queued: queue.length, uptime: process.uptime() });
});

app.get("/api/config", async (_req, res) => {
  const cookies = await cookieArgs();
  res.json({ cookies: cookies.length > 0, pot: Boolean(POT_URL), maxClips: MAX_CLIPS });
});

app.get("/api/jobs/:id", async (req, res) => {
  const job = jobs.get(req.params.id) || (await loadJob(req.params.id));
  if (!job) return res.status(404).json({ error: "Trabajo no encontrado." });

  res.json({
    id: job.id,
    status: job.status,
    progress: job.progress,
    message: job.message,
    meta: job.meta,
    segments: job.segments,
    outputs: job.outputs,
    position: job.status === "queued" ? queuePosition(job) : 0,
  });
});

app.get("/api/jobs/:id/thumb/:index", async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).end();
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0 || index >= MAX_CLIPS) return res.status(404).end();
  res.sendFile(path.join(WORK, req.params.id, `thumb-${index}.jpg`), {
    maxAge: "1h",
  }, (err) => err && !res.headersSent && res.status(404).end());
});

app.post("/api/analyze", rateLimit(10, 10 * 60 * 1000), async (req, res) => {
  if (shuttingDown) return res.status(503).json({ error: "Servidor reiniciándose." });
  if (queue.length >= 30) return res.status(503).json({ error: "Cola llena. Prueba en un rato." });

  const url = canonicalUrl(String(req.body?.url ?? "").trim());
  if (!url) return res.status(400).json({ error: "Enlace de YouTube no válido." });

  const id = randomUUID();
  const job = {
    id,
    status: "queued",
    progress: 0,
    message: "En cola",
    createdAt: Date.now(),
    dir: path.join(WORK, id),
  };
  jobs.set(id, job);
  await fs.mkdir(job.dir, { recursive: true });
  await saveJob(job);

  res.json({ jobId: id, position: queue.length + 1 });

  const task = {
    jobId: id,
    run: () => analyzeJob(job, url),
  };
  enqueue(task).catch(async (err) => {
    job.status = "error";
    job.message = err.message;
    await saveJob(job);
  });
});

app.post(
  "/api/upload",
  rateLimit(5, 10 * 60 * 1000),
  (req, res, next) => {
    if (shuttingDown) return res.status(503).json({ error: "Servidor reiniciándose." });
    if (queue.length >= 30) return res.status(503).json({ error: "Cola llena. Prueba en un rato." });
    next();
  },
  (req, res, next) => {
    upload.single("video")(req, res, (err) => {
      if (err) {
        return res.status(400).json({
          error: err.message || "Error al subir el archivo.",
        });
      }
      next();
    });
  },
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No se recibió ningún archivo." });

    const id = randomUUID();
    const job = {
      id,
      status: "queued",
      progress: 0,
      message: "En cola",
      createdAt: Date.now(),
      dir: path.join(WORK, id),
    };
    jobs.set(id, job);
    await fs.mkdir(job.dir, { recursive: true });
    await saveJob(job);

    res.json({ jobId: id, position: queue.length + 1 });

    const uploadPath = req.file.path;
    const originalName = req.file.originalname || "video.mp4";
    enqueue({ jobId: id, run: () => analyzeFileJob(job, uploadPath, originalName) }).catch(
      async (err) => {
        job.status = "error";
        job.message = err.message;
        await saveJob(job);
        await fs.rm(uploadPath, { force: true }).catch(() => {});
      },
    );
  },
);

app.post("/api/jobs/:id/cut", rateLimit(20, 10 * 60 * 1000), async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job?.source) return res.status(404).json({ error: "Trabajo no encontrado o sin archivo." });
  if (job.status === "cutting") return res.status(409).json({ error: "Ya se está cortando." });

  const format = ["original", "vertical-crop", "vertical-blur"].includes(req.body?.format)
    ? req.body.format
    : "original";

  const segments = (req.body?.segments || [])
    .map((s) => ({ start: Math.max(0, Number(s.start)), end: Number(s.end) }))
    .filter((s) =>
      Number.isFinite(s.start) && Number.isFinite(s.end)
      && s.end - s.start >= 1
      && s.end - s.start <= MAX_CLIP_SECONDS
      && s.start < job.meta.duration)
    .slice(0, MAX_CLIPS);

  if (!segments.length) {
    return res.status(400).json({
      error: `Marca al menos un corte válido (entre 1 y ${MAX_CLIP_SECONDS} segundos).`,
    });
  }

  res.json({ ok: true });
  enqueue({ jobId: job.id, run: () => cutJob(job, segments, format) }).catch(() => {});
});

app.get("/clips/:file", (req, res) => {
  const file = path.basename(req.params.file);
  if (!/\.mp4$/.test(file)) return res.status(404).end();
  res.download(path.join(CLIPS, file), file, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

app.use((_req, res) => res.status(404).json({ error: "Ruta no encontrada." }));

/* ---------- limpieza ---------- */

setInterval(() => {
  const now = Date.now();

  for (const [ip, list] of hits) {
    const alive = list.filter((t) => now - t < 10 * 60 * 1000);
    if (alive.length) hits.set(ip, alive);
    else hits.delete(ip);
  }

  for (const [id, job] of jobs) {
    const busy = ["queued", "working", "cutting"].includes(job.status);
    if (!busy && now - job.createdAt > JOB_TTL) {
      jobs.delete(id);
      fs.rm(job.dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}, 5 * 60 * 1000);

async function cleanWorkOnBoot() {
  const cutoff = Date.now() - JOB_TTL;
  for (const name of await fs.readdir(WORK).catch(() => [])) {
    const stat = await fs.stat(path.join(WORK, name)).catch(() => null);
    if (stat && stat.mtimeMs < cutoff) {
      await fs.rm(path.join(WORK, name), { recursive: true, force: true }).catch(() => {});
    }
  }
  // Clean up stale multer temp files
  for (const name of await fs.readdir(UPLOADS).catch(() => [])) {
    const stat = await fs.stat(path.join(UPLOADS, name)).catch(() => null);
    if (stat && stat.mtimeMs < cutoff) {
      await fs.rm(path.join(UPLOADS, name), { force: true }).catch(() => {});
    }
  }
}

/* ---------- arranque ---------- */

for (const bin of ["yt-dlp", "ffmpeg", "ffprobe"]) {
  const check = await run(bin, [bin === "yt-dlp" ? "--version" : "-version"]);
  if (check.code !== 0) {
    console.error(`\n  Falta "${bin}" en el PATH.\n`);
    process.exit(1);
  }
}

await cleanWorkOnBoot();
await enforceDiskQuota();

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`AutoClips escuchando en :${PORT} · concurrencia ${MAX_JOBS} · PO token ${POT_URL ? "sí" : "no"}`);
});

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal}: cerrando…`);
  server.close();
  const deadline = Date.now() + 25_000;
  while (active > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));