export interface Alpha7AssetManifest {
  assetRoot?: string;
  ui?: {
    icons?: Partial<Record<"reticle" | "repair" | "shield", string>>;
  };
  tanks?: Partial<
    Record<
      "nova" | "atlas" | "quill" | "rook",
      {
        model?: string | null;
        texture?: string | null;
        fallback?: string;
      }
    >
  >;
  maps?: {
    wallConcrete?: {
      texture?: string | null;
      normal?: string | null;
      arm?: string | null;
      fallback?: string;
    };
    floorConcrete?: {
      texture?: string | null;
      normal?: string | null;
      roughness?: string | null;
      fallback?: string;
    };
    floorAsphaltPreview?: {
      texture?: string | null;
      normal?: string | null;
      arm?: string | null;
      fallback?: string;
    };
    floorConcreteWornPreview?: {
      texture?: string | null;
      normal?: string | null;
      roughness?: string | null;
      fallback?: string;
    };
    floorPlasteredPreview?: {
      texture?: string | null;
      normal?: string | null;
      arm?: string | null;
      fallback?: string;
    };
    floorRockDryPreview?: {
      texture?: string | null;
      normal?: string | null;
      arm?: string | null;
      fallback?: string;
    };
    wallStonePreview?: {
      texture?: string | null;
      normal?: string | null;
      arm?: string | null;
      fallback?: string;
    };
  };
  fx?: Partial<
    Record<
      "cannonMuzzle" | "smoke" | "zoneWarning",
      {
        sprite?: string | null;
        fallback?: string;
      }
    >
  >;
  audio?: {
    ambientMusic?: {
      src?: string | null;
      fallback?: string;
    };
    tankMove?: {
      src?: string | null;
      fallback?: string;
    };
    tankFire?: {
      src?: string | null;
      fallback?: string;
    };
  };
}

export const DEFAULT_ALPHA7_ASSET_MANIFEST: Alpha7AssetManifest = {
  assetRoot: "/assets",
  ui: {
    icons: {
      reticle: "/assets/ui/icons/reticle.svg",
      repair: "/assets/ui/icons/repair.svg",
      shield: "/assets/ui/icons/shield.svg"
    }
  },
  maps: {
    wallConcrete: {
      texture: "/assets/generated/textures/alpha7-wall-stone-preview-color.jpg",
      normal: "/assets/generated/textures/alpha7-wall-stone-preview-normal.jpg",
      arm: "/assets/generated/textures/alpha7-wall-stone-preview-arm.jpg",
      fallback: "reference-informed-concrete-v4"
    },
    floorConcrete: {
      texture: "/assets/generated/textures/alpha7-floor-concrete-worn-preview-color.jpg",
      normal: "/assets/generated/textures/alpha7-floor-concrete-worn-preview-normal.jpg",
      roughness: "/assets/generated/textures/alpha7-floor-concrete-worn-preview-roughness.jpg",
      fallback: "reference-informed-concrete-v4"
    },
    floorAsphaltPreview: {
      texture: "/assets/generated/textures/alpha7-floor-asphalt-preview-color.jpg",
      normal: "/assets/generated/textures/alpha7-floor-asphalt-preview-normal.jpg",
      arm: "/assets/generated/textures/alpha7-floor-asphalt-preview-arm.jpg",
      fallback: "query-preview-alpha7PreviewFloor-asphalt"
    },
    floorConcreteWornPreview: {
      texture: "/assets/generated/textures/alpha7-floor-concrete-worn-preview-color.jpg",
      normal: "/assets/generated/textures/alpha7-floor-concrete-worn-preview-normal.jpg",
      roughness: "/assets/generated/textures/alpha7-floor-concrete-worn-preview-roughness.jpg",
      fallback: "query-preview-alpha7PreviewFloor-worn"
    },
    floorPlasteredPreview: {
      texture: "/assets/generated/textures/alpha7-floor-plastered-preview-color.jpg",
      normal: "/assets/generated/textures/alpha7-floor-plastered-preview-normal.jpg",
      arm: "/assets/generated/textures/alpha7-floor-plastered-preview-arm.jpg",
      fallback: "query-preview-alpha7PreviewFloor-plaster"
    },
    floorRockDryPreview: {
      texture: "/assets/generated/textures/alpha7-floor-rock-dry-preview-color.jpg",
      normal: "/assets/generated/textures/alpha7-floor-rock-dry-preview-normal.jpg",
      arm: "/assets/generated/textures/alpha7-floor-rock-dry-preview-arm.jpg",
      fallback: "query-preview-alpha7PreviewFloor-rock"
    },
    wallStonePreview: {
      texture: "/assets/generated/textures/alpha7-wall-stone-preview-color.jpg",
      normal: "/assets/generated/textures/alpha7-wall-stone-preview-normal.jpg",
      arm: "/assets/generated/textures/alpha7-wall-stone-preview-arm.jpg",
      fallback: "query-preview-alpha7PreviewWall-stone"
    }
  },
  audio: {
    ambientMusic: {
      src: "/assets/audio/ambient-steel-rain.mp3",
      fallback: "silent-until-user-gesture"
    },
    tankMove: {
      src: "/assets/audio/tank-rumble.mp3",
      fallback: "silent-until-user-gesture"
    },
    tankFire: {
      src: "/assets/audio/tank-fire.wav",
      fallback: "silent-until-user-gesture"
    }
  }
};

export const manifestRuntimeSignature = (manifest: Alpha7AssetManifest): string =>
  JSON.stringify({
    audio: manifest.audio,
    maps: manifest.maps,
    ui: manifest.ui
  });

export const loadAlpha7AssetManifest = async (): Promise<Alpha7AssetManifest> => {
  const response = await fetch("/assets/manifest.json", { cache: "no-cache" });
  if (!response.ok) return DEFAULT_ALPHA7_ASSET_MANIFEST;
  return (await response.json()) as Alpha7AssetManifest;
};
