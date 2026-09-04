import { describe, expect, it } from "vitest";
import { TANK_ARCHETYPES, WEAPON_TYPES } from "@alpha7/shared";
import {
  BACKGROUND_MUSIC_AUDIO,
  EXPLOSIVE_FIRE_AUDIO,
  ORIGINAL_ATMOSPHERE_AUDIO_CUE,
  TANK_FIRE_AUDIO,
  TANK_MOVEMENT_AUDIO,
  chooseNextMenuMusicIndex,
  fireAudioForTank,
  menuMusicPlayCount,
  weatherCanThunder
} from "./audioCatalog";

describe("audio catalog", () => {
  it("gives every tank a distinct movement and primary-fire identity", () => {
    expect(new Set(TANK_ARCHETYPES.map((tank) => TANK_MOVEMENT_AUDIO[tank].src)).size).toBe(
      TANK_ARCHETYPES.length
    );
    expect(new Set(TANK_ARCHETYPES.map((tank) => TANK_FIRE_AUDIO[tank].src)).size).toBe(
      TANK_ARCHETYPES.length
    );
  });

  it("resolves every weapon and keeps explosive fire distinct", () => {
    const resolved = WEAPON_TYPES.map((weapon) => fireAudioForTank("atlas", weapon));
    expect(resolved.every((cue) => cue.src.includes(".mp3"))).toBe(true);
    expect(fireAudioForTank("atlas", "explosive").src).toBe(EXPLOSIVE_FIRE_AUDIO.src);
  });

  it("keeps three distinct music banks and reserves clean tracks for rain maps", () => {
    expect(Object.values(BACKGROUND_MUSIC_AUDIO).every((bank) => bank.length >= 3)).toBe(true);
    const sources = Object.values(BACKGROUND_MUSIC_AUDIO).flatMap((bank) =>
      bank.map((cue) => cue.src)
    );
    expect(new Set(sources).size).toBe(sources.length);
    expect(BACKGROUND_MUSIC_AUDIO.rain.every((cue) => cue.id.startsWith("music-rain-"))).toBe(
      true
    );
    expect(BACKGROUND_MUSIC_AUDIO.menu).toContain(ORIGINAL_ATMOSPHERE_AUDIO_CUE);
  });

  it("rotates menu music without immediately repeating the current cue", () => {
    expect(chooseNextMenuMusicIndex(-1, () => 0)).toBe(0);
    expect(chooseNextMenuMusicIndex(0, () => 0)).toBe(1);
    expect(chooseNextMenuMusicIndex(1, () => 0.999)).toBe(
      BACKGROUND_MUSIC_AUDIO.menu.length - 1
    );
  });

  it("holds short menu tracks for roughly three to four minutes", () => {
    expect(menuMusicPlayCount(26.5)).toBe(8);
    expect(menuMusicPlayCount(29.5)).toBe(8);
    expect(menuMusicPlayCount(168)).toBe(1);
  });

  it("allows thunder only in sufficiently intense rain", () => {
    expect(weatherCanThunder({ kind: "clear", intensity: 0, seed: "clear" })).toBe(false);
    expect(weatherCanThunder({ kind: "rain", intensity: 0.5, seed: "drizzle" })).toBe(false);
    expect(weatherCanThunder({ kind: "rain", intensity: 0.8, seed: "storm" })).toBe(true);
  });
});
