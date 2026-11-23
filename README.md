# AutoClips

**Un reproductor ligero para abrir videos de YouTube desde una sola página.**

AutoClips es un prototipo web estático que permite pegar un enlace de YouTube y reproducirlo en un reproductor integrado cuando el video admite inserción.

> **Estado del proyecto:** prototipo. AutoClips no descarga, analiza ni edita videos, y todavía no genera clips ni subtítulos.

## Funcionalidades

- Reproduce enlaces de videos, Shorts y directos de YouTube.
- Reconoce formatos comunes como `youtube.com/watch`, `youtube.com/live`, `youtube.com/shorts`, `youtu.be` y YouTube Music.
- Valida el enlace antes de cargar el reproductor.
- Incluye un enlace para abrir el video directamente en YouTube si no se puede insertar.
- Diseño adaptable a pantallas móviles y de escritorio.

La reproducción está sujeta a la disponibilidad del video y a la configuración de YouTube. Los videos privados, restringidos o con la inserción desactivada pueden no reproducirse en AutoClips.

## Ejecutar localmente

Se requiere Python 3 para servir la página localmente. No hay dependencias de Node ni pasos de compilación.

Desde PowerShell, en la carpeta del proyecto:

```powershell
python -m http.server 8000 --bind 127.0.0.1
```

Abre [http://127.0.0.1:8000](http://127.0.0.1:8000) en el navegador. Mantén abierta la terminal mientras uses la página; para detener el servidor, presiona `Ctrl+C`.

> No abras `index.html` directamente como archivo: YouTube necesita que la página se sirva mediante HTTP para que el reproductor integrado funcione correctamente.

## Comandos de producción

Con GNU Make y SSH instalados en tu PC, puedes administrar un servidor ya configurado con el servicio `autoclips`:

```sh
make deploy HOST=root@tu-servidor
make logs HOST=root@tu-servidor
make logs HOST=root@tu-servidor SERVICE=pot
make restart HOST=root@tu-servidor
make cookies HOST=root@tu-servidor COOKIE_FILE=secrets/cookies.txt
```

`deploy` actualiza el checkout remoto y recarga el servicio; `cookies` instala el archivo con permisos privados y reinicia AutoClips. `secrets/` está excluido de Git. Estos comandos presuponen que el servidor ya tiene configurados Docker Compose y el servicio systemd de AutoClips.

## Estructura

| Archivo | Descripción |
| --- | --- |
| `index.html` | Estructura de la página y reproductor |
| `styles.css` | Diseño adaptable y estilos |
| `app.js` | Validación de enlaces y carga del video |

## Privacidad

AutoClips no tiene backend ni almacena videos. Al cargar un reproductor o abrir un enlace, el navegador se comunica directamente con YouTube y se aplican las políticas de privacidad de Google/YouTube.
