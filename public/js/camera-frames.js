/** Catálogo de marcos de cámara — compartido panel + overlay OBS
 *  Archivos en public/img/camera-frames/ (PNG con centro transparente).
 *  ?v= obligatorio: el navegador cachea /img/ 7 días con el mismo nombre.
 */
(function (root) {
  const VER = 'mcf4';
  const u = (file) => '/img/camera-frames/' + file + '?v=' + VER;
  const FRAMES = [
    { id: 'vip-gold', name: 'VIP Dorado', img: u('vip-gold.png') },
    { id: 'game-on', name: 'Game On', img: u('game-on.png') },
    { id: 'armor-purple', name: 'Armadura', img: u('armor-purple.png') },
    { id: 'cyber-neon', name: 'Cyber Neon', img: u('cyber-neon.png') },
    { id: 'dragonball', name: 'Dragon Ball', img: u('dragonball.png') },
    { id: 'onepiece', name: 'One Piece', img: u('onepiece.png') },
    { id: 'roblox', name: 'Roblox', img: u('roblox.png') },
    { id: 'minecraft', name: 'Minecraft', img: u('minecraft.png') },
  ];
  const byId = (id) => FRAMES.find((f) => f.id === id) || FRAMES[0];
  root.CAMERA_FRAMES = FRAMES;
  root.cameraFrameById = byId;
  root.CAMERA_FRAMES_VER = VER;
})(typeof window !== 'undefined' ? window : globalThis);
