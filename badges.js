/**
 * Insignias Livecoins — catálogo + cálculo de progreso.
 * Los contadores viven en user.badgeStats / user.manualBadges (auth.js).
 */

/** Arte dorado en /img/badges/{id}.png (PNG transparente). */
function badgeImg(id) {
  return `/img/badges/${id}.png`;
}

export const BADGE_CATALOG = [
  {
    id: 'first_live',
    name: 'Primera live',
    short: '1ª',
    desc: 'Completaste tu primera live con Livecoins (≥15 min).',
    icon: '🎬',
    img: badgeImg('first_live'),
    group: 'lives',
    target: 1,
    progress: (s) => ({ current: Math.min(s.livesCount || 0, 1), target: 1 }),
    earned: (s) => (s.livesCount || 0) >= 1,
  },
  {
    id: 'lives_10',
    name: 'En marcha',
    short: '10',
    desc: '10 lives válidas con Livecoins.',
    icon: '🚀',
    img: badgeImg('lives_10'),
    group: 'lives',
    target: 10,
    progress: (s) => ({ current: Math.min(s.livesCount || 0, 10), target: 10 }),
    earned: (s) => (s.livesCount || 0) >= 10,
  },
  {
    id: 'lives_50',
    name: 'Constante',
    short: '50',
    desc: '50 lives válidas con Livecoins.',
    icon: '🔥',
    img: badgeImg('lives_50'),
    group: 'lives',
    target: 50,
    progress: (s) => ({ current: Math.min(s.livesCount || 0, 50), target: 50 }),
    earned: (s) => (s.livesCount || 0) >= 50,
  },
  {
    id: 'lives_100',
    name: 'Veterano',
    short: '100',
    desc: '100 lives válidas con Livecoins.',
    icon: '⭐',
    img: badgeImg('lives_100'),
    group: 'lives',
    target: 100,
    progress: (s) => ({ current: Math.min(s.livesCount || 0, 100), target: 100 }),
    earned: (s) => (s.livesCount || 0) >= 100,
  },
  {
    id: 'lives_500',
    name: 'Leyenda',
    short: '500',
    desc: '500 lives válidas con Livecoins.',
    icon: '👑',
    img: badgeImg('lives_500'),
    group: 'lives',
    target: 500,
    progress: (s) => ({ current: Math.min(s.livesCount || 0, 500), target: 500 }),
    earned: (s) => (s.livesCount || 0) >= 500,
  },
  {
    id: 'streak_3',
    name: 'Racha 3',
    short: 'R3',
    desc: '3 días seguidos en live (≥15 min cada día).',
    icon: '📅',
    img: badgeImg('streak_3'),
    group: 'streak',
    target: 3,
    progress: (s) => ({
      current: Math.min(Math.max(s.streak || 0, s.bestStreak || 0), 3),
      target: 3,
    }),
    earned: (s) => (s.streak || 0) >= 3 || (s.bestStreak || 0) >= 3,
  },
  {
    id: 'streak_7',
    name: 'Racha 7',
    short: 'R7',
    desc: '7 días seguidos en live (≥15 min cada día).',
    icon: '🗓️',
    img: badgeImg('streak_7'),
    group: 'streak',
    target: 7,
    progress: (s) => ({
      current: Math.min(Math.max(s.streak || 0, s.bestStreak || 0), 7),
      target: 7,
    }),
    earned: (s) => (s.streak || 0) >= 7 || (s.bestStreak || 0) >= 7,
  },
  {
    id: 'on_map',
    name: 'En el mapa',
    short: 'Mapa',
    desc: 'Apareciste en «En live con Livecoins».',
    icon: '🗺️',
    img: badgeImg('on_map'),
    group: 'community',
    progress: (s) => ({ current: s.seenInDirectory ? 1 : 0, target: 1 }),
    earned: (s) => !!s.seenInDirectory,
  },
  {
    id: 'popular',
    name: 'Popular',
    short: '1K',
    desc: 'Sumaste 1.000 viewers (pico por live) en lives válidas.',
    icon: '👀',
    img: badgeImg('popular'),
    group: 'community',
    target: 1000,
    progress: (s) => ({ current: Math.min(s.viewersTotal || 0, 1000), target: 1000 }),
    earned: (s) => (s.viewersTotal || 0) >= 1000,
  },
  {
    id: 'daily_top',
    name: 'Foco de la noche',
    short: '#1',
    desc: 'Fuiste #1 del día en horas de live (ranking Livecoins).',
    icon: '🏆',
    img: badgeImg('daily_top'),
    group: 'community',
    progress: (s) => ({ current: s.dailyTop1 ? 1 : 0, target: 1 }),
    earned: (s) => !!s.dailyTop1,
  },
  {
    id: 'vip',
    name: 'VIP',
    short: 'VIP',
    desc: 'Tienes plan Premium activo.',
    icon: '💎',
    img: badgeImg('vip'),
    group: 'plan',
    progress: (_s, _u, plan) => ({ current: plan === 'premium' ? 1 : 0, target: 1 }),
    earned: (_s, _u, plan) => plan === 'premium',
  },
  {
    id: 'desktop',
    name: 'App PC',
    short: 'PC',
    desc: 'Entraste al menos una vez desde la app de escritorio (.exe).',
    icon: '💻',
    img: badgeImg('desktop'),
    group: 'product',
    progress: (s) => ({ current: s.usedDesktop ? 1 : 0, target: 1 }),
    earned: (s) => !!s.usedDesktop,
  },
  {
    id: 'gamer',
    name: 'Gamer',
    short: 'Game',
    desc: 'Usaste 3 juegos distintos desde Livecoins.',
    icon: '🎮',
    img: badgeImg('gamer'),
    group: 'games',
    target: 3,
    progress: (s) => ({
      current: Math.min((s.gamesUsed || []).length, 3),
      target: 3,
    }),
    earned: (s) => ((s.gamesUsed || []).length >= 3),
  },
  {
    id: 'partner',
    name: 'Partner',
    short: 'Partner',
    desc: 'Partner oficial de Livecoins.',
    icon: '🤝',
    img: badgeImg('partner'),
    group: 'special',
    manual: true,
    progress: (_s, _u, _p, manual) => ({ current: manual.includes('partner') ? 1 : 0, target: 1 }),
    earned: (_s, _u, _p, manual) => manual.includes('partner'),
  },
  {
    id: 'beta',
    name: 'Beta',
    short: 'Beta',
    desc: 'Probador early de Livecoins.',
    icon: '🧪',
    img: badgeImg('beta'),
    group: 'special',
    manual: true,
    progress: (_s, _u, _p, manual) => ({ current: manual.includes('beta') ? 1 : 0, target: 1 }),
    earned: (_s, _u, _p, manual) => manual.includes('beta'),
  },
  {
    id: 'staff',
    name: 'Staff',
    short: 'Staff',
    desc: 'Equipo / staff de la comunidad Livecoins.',
    icon: '🛡️',
    img: badgeImg('staff'),
    group: 'special',
    manual: true,
    progress: (_s, _u, _p, manual) => ({ current: manual.includes('staff') ? 1 : 0, target: 1 }),
    earned: (_s, _u, _p, manual) => manual.includes('staff'),
  },
];

export const MANUAL_BADGE_IDS = BADGE_CATALOG.filter((b) => b.manual).map((b) => b.id);

const CARD_PRIORITY = [
  'staff', 'partner', 'beta', 'leyenda', 'lives_500', 'lives_100', 'lives_50',
  'daily_top', 'streak_7', 'gamer', 'popular', 'vip', 'desktop', 'lives_10',
  'streak_3', 'on_map', 'first_live',
];

export function emptyBadgeStats() {
  return {
    livesCount: 0,
    lastLiveDay: '',
    streak: 0,
    bestStreak: 0,
    seenInDirectory: false,
    viewersTotal: 0,
    dailyTop1: false,
    usedDesktop: false,
    gamesUsed: [],
  };
}

/** Lista completa con earned + progress (para Inicio /api/me). */
export function buildBadgesForUser(user, plan = 'free') {
  const stats = { ...emptyBadgeStats(), ...(user?.badgeStats || {}) };
  if (!Array.isArray(stats.gamesUsed)) stats.gamesUsed = [];
  const manual = Array.isArray(user?.manualBadges)
    ? user.manualBadges.map(String)
    : [];
  const effectivePlan = user?.isAdmin ? 'premium' : (plan === 'premium' ? 'premium' : 'free');

  return BADGE_CATALOG.map((def) => {
    const earned = !!def.earned(stats, user, effectivePlan, manual);
    const progress = def.progress ? def.progress(stats, user, effectivePlan, manual) : null;
    return {
      id: def.id,
      name: def.name,
      short: def.short,
      desc: def.desc,
      icon: def.icon,
      img: def.img || `/img/badges/${def.id}.png`,
      group: def.group,
      manual: !!def.manual,
      earned,
      progress,
    };
  });
}

/** Insignias ganadas para tarjetas «En live» (todas, orden por prioridad). */
export function pickCardBadges(badges, limit = Infinity) {
  const earned = (badges || []).filter((b) => b.earned);
  earned.sort((a, b) => {
    const ia = CARD_PRIORITY.indexOf(a.id);
    const ib = CARD_PRIORITY.indexOf(b.id);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const n = Number.isFinite(limit) ? Math.max(0, limit) : earned.length;
  return earned.slice(0, n).map((b) => ({
    id: b.id,
    name: b.name,
    short: b.short,
    icon: b.icon,
    img: b.img || `/img/badges/${b.id}.png`,
  }));
}

/** Mapea exec.tipo de juegos → clave game_*. */
export function gameKeyFromExecTipo(tipo) {
  const t = String(tipo || '').toUpperCase();
  if (!t) return '';
  if (t.startsWith('MARIO_') || t === 'SMBX' || t.includes('SMBX')) return 'game_mariobros';
  if (t.startsWith('SMB3_')) return 'game_smb3';
  if (t.startsWith('SMW_')) return 'game_smw';
  if (t.startsWith('MARI0_')) return 'game_mari0';
  if (t.startsWith('PVZ_HYBRID') || t.startsWith('PVZHYBRID') || t.includes('PVZ_HYBRID')) return 'game_pvzhybrid';
  if (t.startsWith('PVZ_')) return 'game_plantasvszombies';
  if (t.startsWith('REPO_')) return 'game_repo';
  if (t.startsWith('L4D_')) return 'game_l4d';
  if (t.startsWith('UNTURNED_')) return 'game_unturned';
  if (t.startsWith('GTAV_CHAOS') || t.startsWith('GTAVCHAOS')) return 'game_gtavchaos';
  if (t.startsWith('GTAV_CHILIAD') || t.startsWith('GTAVCHILIAD')) return 'game_gtavchiliad';
  if (t.startsWith('GTAV_') || t.startsWith('GTAVKOTH')) return 'game_gtavkoth';
  if (t.startsWith('CTR_') || t.startsWith('CRASH')) return 'game_crashctr';
  if (t.startsWith('MSLUG_') || t.startsWith('METALSLUG')) return 'game_metalslug';
  if (t.startsWith('GD_') || t.startsWith('GEOMETRY')) return 'game_geometrydash';
  if (t.startsWith('MC_') || t.startsWith('MINECRAFT') || t.startsWith('RCON') || t.startsWith('SERVERTAP')) return 'game_minecraft';
  if (t.startsWith('BEDROCK') || t.startsWith('CUBO')) return 'game_bedrock';
  if (t.startsWith('SANDBOX')) return 'game_sandbox';
  if (t.startsWith('ROBLOX3') || t.includes('ROBLOX_PARKOUR')) return 'game_roblox3';
  if (t.startsWith('ROBLOX')) return 'game_roblox';
  if (t.includes('PARKOUR') && t.includes('MC')) return 'game_mcparkour';
  if (t.includes('KOTH') && t.includes('MC')) return 'game_mckoth';
  if (t.includes('FARM') && t.includes('MC')) return 'game_mcfarm';
  if (t.includes('SHOOT')) return 'game_mcshooter';
  if (t.includes('MCSERVIDOR') || t.includes('MC_SERVER')) return 'game_mcservidor';
  return '';
}

export function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function prevDayKey(dk) {
  const [y, mo, d] = String(dk).split('-').map(Number);
  const dt = new Date(y, mo - 1, d, 12, 0, 0, 0);
  dt.setDate(dt.getDate() - 1);
  return dayKey(dt.getTime());
}

/** Live mínima para contar (15 min). */
export const BADGE_LIVE_MIN_MS = 15 * 60 * 1000;
