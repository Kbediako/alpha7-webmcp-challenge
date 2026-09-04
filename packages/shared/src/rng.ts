export interface SeededRng {
  readonly seed: string;
  next(): number;
  float(min?: number, max?: number): number;
  int(min: number, max: number): number;
  bool(probability?: number): boolean;
  pick<T>(values: readonly T[]): T;
  shuffle<T>(values: readonly T[]): T[];
  fork(salt: string | number): SeededRng;
}

export const hashSeed = (seed: string | number): number => {
  const source = String(seed);
  let hash = 2166136261;

  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
};

const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

export const createSeededRng = (seed: string | number): SeededRng => {
  const seedString = String(seed);
  const next = mulberry32(hashSeed(seedString));

  const rng: SeededRng = {
    seed: seedString,
    next,
    float(min = 0, max = 1) {
      return min + (max - min) * next();
    },
    int(min: number, max: number) {
      const lower = Math.ceil(Math.min(min, max));
      const upper = Math.floor(Math.max(min, max));
      return Math.floor(next() * (upper - lower + 1)) + lower;
    },
    bool(probability = 0.5) {
      return next() < Math.min(1, Math.max(0, probability));
    },
    pick<T>(values: readonly T[]) {
      if (values.length === 0) {
        throw new Error("Cannot pick from an empty array");
      }
      return values[rng.int(0, values.length - 1)] as T;
    },
    shuffle<T>(values: readonly T[]) {
      const shuffled = [...values];
      for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const swapIndex = rng.int(0, index);
        [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex] as T, shuffled[index] as T];
      }
      return shuffled;
    },
    fork(salt: string | number) {
      return createSeededRng(`${seedString}:${String(salt)}`);
    }
  };

  return rng;
};
