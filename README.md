# AutoClips

Convierte un video en clips MP4 listos para publicar. Pega un enlace de YouTube **o sube tu propio archivo de video**, elige los cortes y descarga los MP4.

## Funcionalidades

- **Subida de archivo propio** (MP4, MKV, MOV, WebM…) — sin dependencia de YouTube.
- **Enlace de YouTube** — compatible con `watch`, `live`, `shorts`, `youtu.be` y YouTube Music.
- Detección automática de silencios para sugerir puntos de corte.
- Editor de segmentos con miniaturas, tiempos ajustables y vista previa.
- Exportación en horizontal (original), vertical 9:16 con recorte o con fondo desenfocado.
- Cola de trabajos en segundo plano con barra de progreso en tiempo real.
- Rotación automática del disco cuando se alcanza el límite de almacenamiento.

## Aviso sobre YouTube

yt-dlp puede fallar con URLs de YouTube cuando el servidor es detectado como bot por las protecciones de la plataforma. Si necesitas procesar contenido propio alojado en YouTube, descárgalo primero en tu dispositivo y súbelo con la opción de archivo. Respeta los términos de servicio de cada plataforma y los derechos de autor.

## Ejecutar localmente con Docker

```sh
docker compose up --build
```

Abre [http://localhost:8080](http://localhost:8080).

Para pasar cookies de YouTube (opcional):

```sh
make cookies HOST=root@tu-servidor COOKIE_FILE=secrets/cookies.txt
```

## Despliegue en Fly.io (sin VPS)

### Requisitos

- Cuenta en [fly.io](https://fly.io)
- `flyctl` instalado

### Pasos

```sh
# 1. Autenticarse
flyctl auth login

# 2. Crear la app (solo la primera vez)
flyctl apps create autoclips

# 3. Crear volúmenes persistentes (solo la primera vez)
flyctl volumes create autoclips_clips --size 10 --region mad
flyctl volumes create autoclips_work  --size 10 --region mad

# 4. Desplegar
flyctl deploy
```

### Variables de entorno opcionales

Configúralas como secrets para que no queden en el repositorio:

```sh
flyctl secrets set POT_URL="http://..." YTDLP_PROXY="socks5://..."
```

| Variable | Descripción | Valor por defecto |
|---|---|---|
| `MAX_JOBS` | Trabajos en paralelo | `1` |
| `MAX_DURATION_MIN` | Duración máxima del video (minutos) | `90` |
| `MAX_CLIPS` | Clips máximos por trabajo | `6` |
| `MAX_CLIPS_GB` | Espacio máximo para clips (GB) | `5` |
| `MAX_UPLOAD_GB` | Tamaño máximo de archivo subido (GB) | `2` |
| `JOB_TTL_MIN` | Tiempo de vida de un trabajo (minutos) | `120` |
| `POT_URL` | URL del servidor de PO tokens | — |
| `COOKIES_FILE` | Ruta al fichero `cookies.txt` de YouTube | — |
| `YTDLP_PROXY` | Proxy para yt-dlp | — |

## Comandos de gestión remota

```sh
make deploy  HOST=root@tu-servidor
make logs    HOST=root@tu-servidor
make restart HOST=root@tu-servidor
make cookies HOST=root@tu-servidor COOKIE_FILE=secrets/cookies.txt
```

## Estructura

| Archivo | Descripción |
|---|---|
| `server.js` | Backend Express: análisis, subida, corte, cola |
| `public/index.html` | Interfaz de usuario |
| `public/app.js` | Lógica del cliente |
| `public/styles.css` | Estilos |
| `Dockerfile` | Imagen con Node, FFmpeg y yt-dlp |
| `docker-compose.yml` | Entorno local con servidor de PO tokens |
| `fly.toml` | Configuración de despliegue en Fly.io |

## Privacidad

Los archivos subidos y los clips generados se eliminan automáticamente tras el tiempo de vida configurado (`JOB_TTL_MIN`). No se almacena ningún dato de usuario ni se comparte con terceros.
