const form = document.querySelector("#clip-form");
const urlInput = document.querySelector("#youtube-url");
const urlWrap = document.querySelector("#url-input-wrap");
const urlError = document.querySelector("#url-error");
const videoResult = document.querySelector("#video-result");
const player = document.querySelector("#youtube-player");
const openYouTube = document.querySelector("#open-youtube");

function getYouTubeVideoId(value) {
  try {
    const address = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`;
    const url = new URL(address);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    let videoId;

    if (
      !["http:", "https:"].includes(url.protocol)
      || !["youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "youtube-nocookie.com"].includes(host)
    ) {
      return null;
    }

    if (host === "youtu.be") {
      videoId = url.pathname.split("/").filter(Boolean)[0];
    } else if (/^\/watch\/?$/.test(url.pathname)) {
      videoId = url.searchParams.get("v");
    } else {
      videoId = url.pathname.match(/^\/(?:live|shorts|embed|v|e)\/([^/?]+)/i)?.[1];
    }

    return videoId && /^[A-Za-z0-9_-]{11}$/.test(videoId) ? videoId : null;
  } catch {
    return null;
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const value = urlInput.value.trim();
  const videoId = getYouTubeVideoId(value);

  videoResult.hidden = true;
  player.removeAttribute("src");
  urlError.textContent = "";
  urlWrap.classList.remove("invalid");

  if (!videoId) {
    urlError.textContent = "Pega un enlace válido de un video, Short o directo de YouTube.";
    urlWrap.classList.add("invalid");
    urlInput.setAttribute("aria-invalid", "true");
    urlInput.focus();
    return;
  }

  urlInput.setAttribute("aria-invalid", "false");
  player.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}`;
  openYouTube.href = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  videoResult.hidden = false;
  videoResult.scrollIntoView({ behavior: "smooth", block: "nearest" });
});

urlInput.addEventListener("input", () => {
  if (urlError.textContent) {
    urlError.textContent = "";
    urlWrap.classList.remove("invalid");
    urlInput.removeAttribute("aria-invalid");
  }
});
