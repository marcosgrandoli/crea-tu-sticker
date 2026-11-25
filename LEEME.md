# Creá tu sticker

Página para hacer stickers con sonido para WhatsApp, en onda shitposting. Son dos archivos (`index.html` y `logo.svg`): no necesita servidor propio ni base de datos.

## Qué hace
- Pegás un link de **X/Twitter** o **TikTok** y el video se convierte en sticker con su mismo audio. Usa los servicios gratis FxTwitter y TikWM: son de terceros y podrían dejar de andar algún día.
- También se puede subir un video, GIF o sticker propio, o buscar GIFs y stickers de GIPHY.
- Ejemplos de memes (gato HUH, Pedro, Maxwell, Moai…) que rotan solos.
- "Editar (opcional)": sonidos propios generados por la página (Boom, Tubo de metal, Bong…), efectos (earrape, reverb, lento, bass boost), texto, animación, 🍟 frito y 🎲 random.
- El nombre del archivo lleva la marca: `creatusticker.com - nombre.mp4`.

## Cómo publicarla gratis
- **Netlify Drop**: entrá a app.netlify.com/drop y arrastrá esta carpeta. Te da un link al instante.
- También sirven **GitHub Pages**, **Vercel** o **Cloudflare Pages**. Después conectás tu dominio.

Tiene que estar en `https://` para que funcionen el micrófono y el botón de guardar en el celular.

## Configurar (arriba de todo en el `<script>` de index.html)
- `MARCA`: lo que va al principio del nombre de cada archivo.
- `GIPHY_API_KEY`: clave gratis de developers.giphy.com. Sin esto, el buscador de GIFs no anda (los ejemplos sí).
- `COBALT_API` / `COBALT_KEY`: opcional, para links de Instagram con un servidor cobalt propio.
- `DURACION_MAX`: segundos máximos del sticker (5 recomendado).
- `SONIDOS_DEL_SITIO`: tus sonidos. Poné los archivos en `sonidos/` y agregá una línea por cada uno. Usá solo sonidos que tengas permiso de usar.
