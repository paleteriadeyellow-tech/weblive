# 📡 Hokey Live — Panel ligero estilo TikFinity

Panel web para ver en tiempo real los eventos de un **TikTok LIVE**: chat, regalos 🎁,
likes ❤️, diamantes 💎, follows, shares y entradas. Incluye un **overlay para OBS**
con alertas animadas. Hecho en **Node.js** sin base de datos, pensado para correr en
**PCs de bajos recursos**.

Es **multiusuario**: cada persona crea su cuenta y trabaja en su propia *room*, con su
conexión a TikTok, ajustes y overlays totalmente separados (las alertas y datos de un
usuario nunca se mezclan con los de otro).

## ✨ Características

Panel con **menú lateral** y 6 secciones:

- **📊 Panel**: estadísticas en vivo (viewers, likes, diamantes, regalos, comentarios,
  follows, shares, entradas), chat en tiempo real, feed de regalos y ranking de quién
  más regala.
- **🔔 Alertas**: elige qué eventos disparan alerta en el overlay (regalos, follows,
  shares, entradas, likes), filtro por diamantes mínimos, duración y botones de prueba.
- **🎬 Videos**: reproduce un video/GIF en el overlay cuando ocurre un evento (por
  ejemplo, un regalo concreto o con cierto valor en diamantes).
- **⚔️ Batallas**: marcador *versus* para juegos de equipos; los diamantes de los
  regalos suman al equipo activo. Incluye overlay de barra de batalla.
- **🖼️ Overlays**: URLs listas para copiar y pegar en OBS.
- **🗣️ Chat TTS**: lee el chat en voz alta (voz, velocidad, tono, volumen, filtros).

Súper ligero: solo `express`, `ws` y `tiktok-live-connector`. Sin base de datos; los
ajustes se guardan en un pequeño `settings.json`.

## ▶️ Uso rápido (Windows)

1. Instala **Node.js LTS** desde <https://nodejs.org> (si no lo tienes).
2. Doble clic en **`iniciar.bat`**.
   - La primera vez instala las dependencias automáticamente.
   - Luego abre el navegador en la pantalla de **acceso**.
3. **Crea tu cuenta** (usuario + contraseña) o inicia sesión. Entrarás a tu panel privado.
4. Escribe el `@usuario` de TikTok que esté **en vivo** y pulsa **Conectar**.

> La primera cuenta que registres hereda automáticamente la configuración que ya tuvieras
> guardada (`settings.json`). Los usuarios se guardan en la carpeta `data/` (no la borres).

## ▶️ Uso manual (cualquier sistema)

```bash
npm install
npm start
```

Abre <http://localhost:3000> en el navegador.

## 🎬 Overlays en OBS

En OBS añade una fuente → **Navegador** (ancho 1920, alto 1080, fondo transparente).

**Importante:** copia las URLs desde la pestaña **Overlays** del panel (botón de copiar).
Esas URLs ya incluyen tu **clave de room** (`?room=...`) para que el overlay se conecte a
**tu** cuenta. Si copias una URL sin esa clave, OBS no recibirá tus eventos.

Ejemplo (con tu clave añadida automáticamente): `http://localhost:3000/overlay.html?room=TU_CLAVE`

Las alertas y videos respetan lo que configures en las pestañas **Alertas** y **Videos**.
La barra de batalla solo aparece cuando activas el **modo batalla** en su pestaña.

## ⚙️ Configuración

- **Puerto**: por defecto `3000`. Cámbialo con la variable `PORT`:
  ```bash
  set PORT=4000 && npm start   # Windows
  PORT=4000 npm start          # Linux/Mac
  ```
- **Filtrar alertas pequeñas en el overlay**: edita `MIN_DIAMONDS` en
  `public/js/overlay.js`.
- **Voces OpenAI (Chat TTS)**: para usar las voces de IA de OpenAI, configura la
  variable de entorno `OPENAI_API_KEY` con tu clave de OpenAI (en Render:
  *Settings → Environment*). La clave vive solo en el servidor (nunca se envía al
  navegador ni a los overlays). Sin esa clave, las voces OpenAI no funcionan y el
  Chat TTS usa la voz del sistema o las voces TikTok. El uso consume créditos de
  tu cuenta de OpenAI.
  ```bash
  set OPENAI_API_KEY=sk-...   && npm start   # Windows
  OPENAI_API_KEY=sk-... npm start             # Linux/Mac
  ```

## 📂 Estructura

```
server.js              Servidor (Express + WebSocket + conexión a TikTok + ajustes)
settings.json          Ajustes guardados (se crea solo)
public/
  index.html           Panel principal (menú lateral con 6 secciones)
  overlay.html         Overlay de alertas + videos para OBS
  battle.html          Overlay de batalla (versus) para OBS
  css/  js/            Estilos y lógica del navegador
iniciar.bat            Arrancador para Windows (doble clic)
```

## 🗣️ Nota sobre el Chat TTS

La lectura por voz usa el motor de voz del navegador (Web Speech API) y se ejecuta en
la pestaña del **panel**, así que deja esa pestaña abierta para que siga leyendo. No
consume recursos del overlay ni del servidor.

## ❓ Notas

- El usuario **debe estar en vivo** para poder conectar.
- TikTok puede limitar conexiones desde la misma IP si abusas; usa con moderación.
- Esto usa la librería pública `tiktok-live-connector` (no oficial de TikTok).

---

Hecho para divertirse con los lives. 🎉
