import express from "express";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const WORK = path.join(root, "work");
const CLIPS = path.join(root, "clips");
const PORT = Number(process.env.PORT) || 5173;
const MAX_DURATION = 3 * 60 * 60;
const JOB_TTL = 2 * 60 * 60 * 1000;
const FORMAT =
  "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/b";

await fs.mkdir(WORK, { recursive: true });
await fs.mkdir(CLIPS, { recursive: true });

const jobs = new Map();

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

  return segments.slice(0, 10);
}

async function thumbnail(source, at, dir, index) {
  const out = path.join(dir, `thumb-${index}.jpg`);
  const result = await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-ss", String(at), "-i", source,
    "-frames:v", "1", "-vf", "scale=360:-2", out,
  ]);
  if (result.code !== 0) return null;
  const data = await fs.readFile(out);
  return `data:image/jpeg;base64,${data.toString("base64")}`;
}

async function analyzeJob(job, url) {
  await fs.mkdir(job.dir, { recursive: true });

  job.status = "working";
  job.message = "Leyendo el video…";

  const meta = await run("yt-dlp", ["-J", "--no-warnings", "--no-playlist", url], {
    timeout: 90_000,
  });
  if (meta.code !== 0) throw new Error(lastError(meta.stderr) || "No se pudo leer el video.");

  const info = JSON.parse(meta.stdout);
  if (info.is_live) throw new Error("Es un directo en curso. Espera a que termine y se publique.");
  if (!info.duration) throw new Error("El video no tiene duración utilizable.");
  if (info.duration > MAX_DURATION) throw new Error("El video pasa de 3 horas.");

  job.meta = {
    id: info.id,
    title: info.title,
    uploader: info.uploader,
    duration: info.duration,
    thumbnail: info.thumbnail,
  };

  job.message = "Descargando…";
  const dl = await run(
    "yt-dlp",
    [
      "-f", FORMAT,
      "--merge-output-format", "mp4",
      "--no-playlist", "--no-warnings",
      "-o", path.join(job.dir, "source.%(ext)s"),
      url,
    ],
    {
      timeout: 30 * 60 * 1000,
      onData: (text) => {
        const m = text.match(/\[download\]\s+([\d.]+)%/);
        if (m) {
          job.progress = Number(m[1]);
          job.message = `Descargando ${m[1]}%`;
        }
      },
    },
  );
  if (dl.code !== 0) throw new Error(lastError(dl.stderr) || "Falló la descarga.");

  const files = await fs.readdir(job.dir);
  const name = files.find((f) => f.startsWith("source."));
  if (!name) throw new Error("No se encontró el archivo descargado.");
  job.source = path.join(job.dir, name);

  job.message = "Analizando el audio…";
  const probe = await run("ffprobe", [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=nw=1:nk=1", job.source,
  ]);
  const duration = Number(probe.stdout.trim()) || job.meta.duration;

  const silences = [];
  await run("ffmpeg", [
    "-hide_banner", "-i", job.source,
    "-af", "silencedetect=noise=-32dB:d=0.4",
    "-f", "null", "-",
  ], {
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
    segments.push({
      index: i,
      start: Math.round(seg.start * 10) / 10,
      end: Math.round(seg.end * 10) / 10,
      thumb: await thumbnail(job.source, (seg.start + seg.end) / 2, job.dir, i),
    });
    job.progress = Math.round(((i + 1) / raw.length) * 100);
  }

  job.segments = segments;
  job.status = "ready";
  job.progress = 100;
  job.message = `${segments.length} cortes sugeridos`;
}

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
  const f = filterFor(format);
  job.outputs = [];
  job.status = "cutting";

  try {
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      job.progress = Math.round((i / segments.length) * 100);
      job.message = `Cortando ${i + 1} de ${segments.length}…`;

      const file = `${slug(job.meta.title)}-${i + 1}.mp4`;
      const out = path.join(CLIPS, file);

      const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", job.source,
        "-ss", String(seg.start), "-t", String(seg.end - seg.start)];

      if (f.complex) args.push("-filter_complex", f.complex, "-map", "[v]", "-map", "0:a?");
      else if (f.vf) args.push("-vf", f.vf, "-map", "0:v:0", "-map", "0:a?");
      else args.push("-map", "0:v:0", "-map", "0:a?");

      args.push(
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
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
  } catch (err) {
    job.status = "error";
    job.message = err.message;
  }
}

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(root, "public")));
app.use("/clips", express.static(CLIPS));

app.post("/api/analyze", async (req, res) => {
  const url = canonicalUrl(String(req.body?.url ?? "").trim());
  if (!url) return res.status(400).json({ error: "Enlace de YouTube no válido." });

  const job = {
    id: randomUUID(),
    status: "queued",
    progress: 0,
    message: "En cola",
    createdAt: Date.now(),
    dir: path.join(WORK, randomUUID()),
  };
  jobs.set(job.id, job);

  res.json({ jobId: job.id });
  analyzeJob(job, url).catch((err) => {
    job.status = "error";
    job.message = err.message;
  });
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Trabajo no encontrado." });

  res.json({
    id: job.id,
    status: job.status,
    progress: job.progress,
    message: job.message,
    meta: job.meta,
    segments: job.segments,
    outputs: job.outputs,
  });
});

app.post("/api/jobs/:id/cut", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job?.source) return res.status(404).json({ error: "Trabajo no encontrado o sin archivo." });

  const format = ["original", "vertical-crop", "vertical-blur"].includes(req.body?.format)
    ? req.body.format
    : "original";

  const segments = (req.body?.segments || [])
    .map((s) => ({ start: Math.max(0, Number(s.start)), end: Number(s.end) }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end - s.start >= 1)
    .slice(0, 10);

  if (!segments.length) return res.status(400).json({ error: "No hay cortes válidos." });

  res.json({ ok: true });
  cutJob(job, segments, format);
});

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL && job.status !== "cutting") {
      jobs.delete(id);
      fs.rm(job.dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}, 10 * 60 * 1000);

app.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  AutoClips en http://127.0.0.1:${PORT}\n`);
});