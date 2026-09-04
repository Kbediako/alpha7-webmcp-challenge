import {
  TANK_ARCHETYPE_CONFIG,
  type ArenaWeatherConfig,
  type TankArchetypeId,
  type WeaponType
} from "@alpha7/shared";

export type AudioCueCategory = "ambient" | "movement" | "fire" | "ui" | "weather";

export interface AudioCueDefinition {
  id: string;
  category: AudioCueCategory;
  label: string;
  description: string;
  src: string;
  loop: boolean;
  volume: number;
  poolSize?: number;
  playbackRate?: number;
}

export const ORIGINAL_ATMOSPHERE_AUDIO_CUE = {
  id: "music-menu-original-atmosphere",
  category: "ambient",
  label: "Menu — Original Atmosphere",
  description: "The original steel-and-rain atmosphere, remastered as a seamless menu-only loop.",
  src: "/assets/audio/music-menu-original-atmosphere.mp3?v=1",
  loop: true,
  volume: 0.3
} as const satisfies AudioCueDefinition;

export const BACKGROUND_MUSIC_AUDIO = {
  menu: [
    {
      id: "music-menu-low-signal",
      category: "ambient",
      label: "Menu — Low Signal",
      description: "Low smoky keys, deep analog weight, and full-scale steel accents for the concrete hangar.",
      src: "/assets/audio/music-menu-lofi.mp3?v=8",
      loop: true,
      volume: 0.32
    },
    {
      id: "music-menu-workshop",
      category: "ambient",
      label: "Menu — Workshop Hours",
      description: "Baritone keys, muscular bass, and distant workshop impacts in a late-night pocket.",
      src: "/assets/audio/music-menu-workshop.mp3?v=7",
      loop: true,
      volume: 0.32
    },
    {
      id: "music-menu-briefing",
      category: "ambient",
      label: "Menu — Briefing Room",
      description: "Broad dark pads and a firm half-time tactical groove with resonant metal strikes.",
      src: "/assets/audio/music-menu-briefing.mp3?v=7",
      loop: true,
      volume: 0.32
    },
    ORIGINAL_ATMOSPHERE_AUDIO_CUE
  ],
  gameplay: [
    {
      id: "music-gameplay-concrete-drift",
      category: "ambient",
      label: "Dry arena — Concrete Drift",
      description: "A clean dry industrial lo-fi pulse with low-end depth and combat headroom.",
      src: "/assets/audio/music-arena-lofi.mp3?v=9",
      loop: true,
      volume: 0.35
    },
    {
      id: "music-gameplay-dust-circuit",
      category: "ambient",
      label: "Dry arena — Dust Circuit",
      description: "Weighty syncopation, low chopped keys, and full-size track-link percussion.",
      src: "/assets/audio/music-arena-dust-circuit.mp3?v=7",
      loop: true,
      volume: 0.28
    },
    {
      id: "music-gameplay-night-patrol",
      category: "ambient",
      label: "Dry arena — Night Patrol",
      description: "Clean dry nocturnal keys, deep bass pressure, and damped machinery at half-time.",
      src: "/assets/audio/music-arena-night-patrol.mp3?v=10",
      loop: true,
      volume: 0.28
    }
  ],
  rain: [
    {
      id: "music-rain-afterglow",
      category: "ambient",
      label: "Rain arena — Afterglow",
      description: "Clean low Rhodes, powerful muted bass, and no hiss, crackle, rain, or thunder.",
      src: "/assets/audio/music-rain-afterglow.mp3?v=7",
      loop: true,
      volume: 0.28
    },
    {
      id: "music-rain-neon-shelter",
      category: "ambient",
      label: "Rain arena — Neon Shelter",
      description: "A weighty clean sheltered-night groove built beneath the separate rain layer.",
      src: "/assets/audio/music-rain-neon-shelter.mp3?v=7",
      loop: true,
      volume: 0.28
    },
    {
      id: "music-rain-blue-hour",
      category: "ambient",
      label: "Rain arena — Blue Hour",
      description: "Dark clean keys and smooth bass pressure without noise or vinyl texture.",
      src: "/assets/audio/music-rain-blue-hour.mp3?v=7",
      loop: true,
      volume: 0.28
    }
  ]
} as const satisfies Record<"menu" | "gameplay" | "rain", readonly AudioCueDefinition[]>;

export type BackgroundMusicContext = keyof typeof BACKGROUND_MUSIC_AUDIO;

export const chooseNextMenuMusicIndex = (
  currentIndex: number,
  random: () => number = Math.random
): number => {
  const count = BACKGROUND_MUSIC_AUDIO.menu.length;
  if (currentIndex < 0 || currentIndex >= count) {
    return Math.min(count - 1, Math.floor(random() * count));
  }
  const candidate = Math.min(count - 2, Math.floor(random() * (count - 1)));
  return candidate >= currentIndex ? candidate + 1 : candidate;
};

export const menuMusicPlayCount = (durationSeconds: number): number =>
  Number.isFinite(durationSeconds) && durationSeconds > 0 && durationSeconds < 60
    ? Math.ceil(210 / durationSeconds)
    : 1;

export const RAIN_AUDIO_CUE = {
  id: "weather-rain",
  category: "weather",
  label: "Arena rain bed",
  description: "A seamless, thunder-free stereo rain layer whose runtime level follows storm intensity.",
  src: "/assets/audio/rain-ambience.mp3?v=2",
  loop: true,
  volume: 0.3
} as const satisfies AudioCueDefinition;

export const TANK_MOVEMENT_AUDIO = {
  nova: {
    id: "movement-nova",
    category: "movement",
    label: "Nova tracks",
    description: "Full-scale high-torque diesel, armored hull resonance, and massive steel track grind.",
    src: "/assets/audio/tank-move-nova.mp3?v=5",
    loop: true,
    volume: 0.26
  },
  atlas: {
    id: "movement-atlas",
    category: "movement",
    label: "Atlas tracks",
    description: "Broad battle-tank diesel weight, loaded suspension, and dense track-link impacts.",
    src: "/assets/audio/tank-move-atlas.mp3?v=5",
    loop: true,
    volume: 0.29
  },
  quill: {
    id: "movement-quill",
    category: "movement",
    label: "Quill tracks",
    description: "Fast armored drivetrain load and rapid steel links without toy-like motor whine.",
    src: "/assets/audio/tank-move-quill.mp3?v=5",
    loop: true,
    volume: 0.25
  },
  rook: {
    id: "movement-rook",
    category: "movement",
    label: "Rook tracks",
    description: "Enormous low diesel pressure, hull resonance, gearbox load, and crushing treads.",
    src: "/assets/audio/tank-move-rook.mp3?v=5",
    loop: true,
    volume: 0.28,
    playbackRate: 0.97
  }
} as const satisfies Record<TankArchetypeId, AudioCueDefinition>;

export const TANK_FIRE_AUDIO = {
  nova: {
    id: "fire-nova",
    category: "fire",
    label: "Nova assault cannon",
    description: "Full-scale muzzle pressure, armored recoil body, breech return, and concrete reflection.",
    src: "/assets/audio/tank-fire-nova.mp3?v=5",
    loop: false,
    volume: 0.78,
    poolSize: 4
  },
  atlas: {
    id: "fire-atlas",
    category: "fire",
    label: "Atlas light cannon",
    description: "Authoritative medium-cannon concussion with a hard transient and steel breech return.",
    src: "/assets/audio/tank-fire-atlas.mp3?v=5",
    loop: false,
    volume: 0.46,
    poolSize: 4
  },
  quill: {
    id: "fire-quill",
    category: "fire",
    label: "Quill machine gun",
    description: "A dense 30 mm pressure snap and heavy action, kept short for rapid cadence.",
    src: "/assets/audio/tank-fire-quill.mp3?v=5",
    loop: false,
    volume: 0.5,
    poolSize: 11
  },
  rook: {
    id: "fire-rook",
    category: "fire",
    label: "Rook support cannon",
    description: "The bank's largest pressure wave, broad armored recoil, and weighty breech return.",
    src: "/assets/audio/tank-fire-rook.mp3?v=5",
    loop: false,
    volume: 0.88,
    poolSize: 4
  }
} as const satisfies Record<TankArchetypeId, AudioCueDefinition>;

export const EXPLOSIVE_FIRE_AUDIO = {
  id: "fire-explosive",
  category: "fire",
  label: "Explosive round",
  description: "A full-scale launcher air concussion with heavy tube resonance and mechanical return.",
  src: "/assets/audio/tank-fire-explosive.mp3?v=5",
  loop: false,
  volume: 0.78,
  poolSize: 3
} as const satisfies AudioCueDefinition;

export const UI_AUDIO = {
  select: {
    id: "ui-select",
    category: "ui",
    label: "Select chassis",
    description: "A compact tactile selector tick for deliberate menu choices.",
    src: "/assets/audio/ui-select.mp3",
    loop: false,
    volume: 0.28,
    poolSize: 3
  },
  confirm: {
    id: "ui-confirm",
    category: "ui",
    label: "Confirm action",
    description: "A restrained two-part confirmation for joining and starting.",
    src: "/assets/audio/ui-confirm.mp3",
    loop: false,
    volume: 0.5,
    poolSize: 3
  },
  back: {
    id: "ui-back",
    category: "ui",
    label: "Back / leave",
    description: "A soft descending mechanical release for exits and cancellations.",
    src: "/assets/audio/ui-back.mp3",
    loop: false,
    volume: 0.35,
    poolSize: 3
  },
  ready: {
    id: "ui-ready",
    category: "ui",
    label: "Ready up",
    description: "A confident arming latch that reads clearly without becoming an alert.",
    src: "/assets/audio/ui-ready.mp3",
    loop: false,
    volume: 0.34,
    poolSize: 3
  }
} as const satisfies Record<"select" | "confirm" | "back" | "ready", AudioCueDefinition>;

export type UiAudioCue = keyof typeof UI_AUDIO;

export const THUNDER_AUDIO = [
  {
    id: "thunder-close",
    category: "weather",
    label: "Thunder — close",
    description: "A sharp nearby crack rolling into a broad low storm body.",
    src: "/assets/audio/thunder-close.mp3",
    loop: false,
    volume: 0.5,
    poolSize: 2
  },
  {
    id: "thunder-distant",
    category: "weather",
    label: "Thunder — distant",
    description: "A softer horizon rumble for depth and variation between flashes.",
    src: "/assets/audio/thunder-distant.mp3",
    loop: false,
    volume: 0.43,
    poolSize: 2
  }
] as const satisfies readonly AudioCueDefinition[];

export const PRELOAD_AUDIO_CUES = [
  ...Object.values(TANK_FIRE_AUDIO),
  EXPLOSIVE_FIRE_AUDIO,
  ...Object.values(UI_AUDIO),
  ...THUNDER_AUDIO
] as const satisfies readonly AudioCueDefinition[];

export const movementAudioForTank = (archetypeId: TankArchetypeId): AudioCueDefinition =>
  TANK_MOVEMENT_AUDIO[archetypeId];

export const fireAudioForTank = (
  archetypeId: TankArchetypeId,
  weaponType: WeaponType
): AudioCueDefinition => {
  if (weaponType === "explosive") return EXPLOSIVE_FIRE_AUDIO;
  if (TANK_ARCHETYPE_CONFIG[archetypeId].primaryWeapon === weaponType) {
    return TANK_FIRE_AUDIO[archetypeId];
  }
  if (weaponType === "light_cannon") return TANK_FIRE_AUDIO.atlas;
  if (weaponType === "machine_gun") return TANK_FIRE_AUDIO.quill;
  return TANK_FIRE_AUDIO.nova;
};

export const weatherCanThunder = (weather: ArenaWeatherConfig): boolean =>
  weather.kind === "rain" && weather.intensity >= 0.65;

export const AUDIO_REVIEW_GROUPS = [
  {
    id: "music",
    eyebrow: "Context-aware lo-fi",
    title: "Background music",
    cues: Object.values(BACKGROUND_MUSIC_AUDIO).flat()
  },
  {
    id: "weather",
    eyebrow: "Rain maps only",
    title: "Weather layers",
    cues: [RAIN_AUDIO_CUE, ...THUNDER_AUDIO]
  },
  {
    id: "movement",
    eyebrow: "Tracked identity",
    title: "Tank movement",
    cues: Object.values(TANK_MOVEMENT_AUDIO)
  },
  {
    id: "fire",
    eyebrow: "Accepted-shot feedback",
    title: "Weapons",
    cues: [...Object.values(TANK_FIRE_AUDIO), EXPLOSIVE_FIRE_AUDIO]
  },
  {
    id: "ui",
    eyebrow: "Industrial interface",
    title: "Menu and lobby",
    cues: Object.values(UI_AUDIO)
  }
] as const;
