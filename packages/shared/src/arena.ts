import {
  PICKUP_CONFIG,
  PICKUP_TYPES,
  type MatchState,
  type PickupType
} from "./constants.js";
import { createSeededRng, type SeededRng } from "./rng.js";

export const ARENA_CONFIG_VERSION = 1 as const;

const DEFAULT_ARENA_WIDTH = 2400;
const DEFAULT_ARENA_HEIGHT = 1632;
const TARGET_CELL_SIZE = 96;
const MIN_GRID_COLUMNS = 15;
const MIN_GRID_ROWS = 11;
const MAX_PLAYER_SPAWNS = 16;

type GridTile = "#" | ".";
type GridMatrix = GridTile[][];

export interface ArenaGenerationOptions {
  seed: string;
  playerCount: number;
  width?: number;
  height?: number;
}

export interface ArenaPoint {
  x: number;
  y: number;
}

export interface ArenaRect extends ArenaPoint {
  id: string;
  width: number;
  height: number;
  kind: "wall" | "collision";
}

export interface ArenaGridCell extends ArenaPoint {
  column: number;
  row: number;
  width: number;
  height: number;
}

export interface ArenaGridConfig {
  columns: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  layout: string[];
}

export interface ArenaPocket extends ArenaPoint {
  id: string;
  column: number;
  row: number;
  columnSpan: number;
  rowSpan: number;
  width: number;
  height: number;
}

export interface ArenaChokePoint extends ArenaPoint {
  id: string;
  column: number;
  row: number;
  clearanceRadius: number;
}

export interface ArenaSpawnPoint extends ArenaPoint {
  id: string;
  playerSlot: number;
  rotation: number;
  radius: number;
}

export interface ArenaPickupPlacement extends ArenaPoint {
  id: string;
  pickupType: PickupType;
  radius: number;
  value: number;
  durationMs: number;
  respawnMs: number;
}

export interface ZonePlan {
  index: number;
  matchState: Extract<MatchState, "running" | "danger" | "final_zone">;
  startsAt: number;
  warningAt: number;
  closesAt: number;
  x: number;
  y: number;
  radius: number;
  targetX: number;
  targetY: number;
  targetRadius: number;
  damagePerSecond: number;
}

export type ArenaWeatherKind = "clear" | "rain";

export interface ArenaWeatherConfig {
  kind: ArenaWeatherKind;
  intensity: number;
  seed: string;
}

export interface ArenaConfig {
  version: typeof ARENA_CONFIG_VERSION;
  seed: string;
  playerCount: number;
  width: number;
  height: number;
  grid: ArenaGridConfig;
  floorCells: ArenaGridCell[];
  wallCells: ArenaGridCell[];
  wallRects: ArenaRect[];
  collisionRects: ArenaRect[];
  pockets: ArenaPocket[];
  chokePoints: ArenaChokePoint[];
  spawnPoints: ArenaSpawnPoint[];
  pickupPlacements: ArenaPickupPlacement[];
  zonePhases: ZonePlan[];
  weather: ArenaWeatherConfig;
}

export interface ArenaConnectivityResult {
  ok: boolean;
  reachableFloorCount: number;
  floorCount: number;
}

const roundCoord = (value: number): number => Math.round(value * 1000) / 1000;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const normalizeDimension = (value: number | undefined, fallback: number, minimum: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.round(value));
};

const normalizePlayerCount = (value: number): number => {
  if (!Number.isFinite(value)) return 1;
  return clamp(Math.floor(value), 1, MAX_PLAYER_SPAWNS);
};

const oddGridCount = (dimension: number, minimum: number): number => {
  const rounded = Math.max(minimum, Math.round(dimension / TARGET_CELL_SIZE));
  return rounded % 2 === 1 ? rounded : rounded + 1;
};

const cellKey = (column: number, row: number): string => `${column},${row}`;

const distance = (a: ArenaPoint, b: ArenaPoint): number => Math.hypot(a.x - b.x, a.y - b.y);

const isInteriorCell = (column: number, row: number, columns: number, rows: number): boolean =>
  column > 0 && row > 0 && column < columns - 1 && row < rows - 1;

const createWallGrid = (rows: number, columns: number): GridMatrix =>
  Array.from({ length: rows }, () => Array<GridTile>(columns).fill("#"));

const setFloor = (grid: GridMatrix, column: number, row: number): void => {
  const gridRow = grid[row];
  if (!gridRow || column < 0 || column >= gridRow.length) return;
  gridRow[column] = ".";
};

const isFloorInGrid = (grid: GridMatrix, column: number, row: number): boolean =>
  grid[row]?.[column] === ".";

const isFloorInLayout = (layout: readonly string[], column: number, row: number): boolean =>
  layout[row]?.charAt(column) === ".";

const oddInteriorCells = (columns: number, rows: number): Array<{ column: number; row: number }> => {
  const cells: Array<{ column: number; row: number }> = [];
  for (let row = 1; row < rows - 1; row += 2) {
    for (let column = 1; column < columns - 1; column += 2) {
      cells.push({ column, row });
    }
  }
  return cells;
};

const carveMaze = (columns: number, rows: number, rng: SeededRng): GridMatrix => {
  const grid = createWallGrid(rows, columns);
  const starts = oddInteriorCells(columns, rows);
  const start = rng.pick(starts);
  const stack = [start];
  const visited = new Set<string>([cellKey(start.column, start.row)]);

  setFloor(grid, start.column, start.row);

  while (stack.length > 0) {
    const current = stack[stack.length - 1];
    if (!current) break;

    const directions = rng.shuffle([
      { dx: 0, dy: -2 },
      { dx: 2, dy: 0 },
      { dx: 0, dy: 2 },
      { dx: -2, dy: 0 }
    ] as const);
    const next = directions.find(({ dx, dy }) => {
      const column = current.column + dx;
      const row = current.row + dy;
      return isInteriorCell(column, row, columns, rows) && !visited.has(cellKey(column, row));
    });

    if (!next) {
      stack.pop();
      continue;
    }

    const nextColumn = current.column + next.dx;
    const nextRow = current.row + next.dy;
    setFloor(grid, current.column + next.dx / 2, current.row + next.dy / 2);
    setFloor(grid, nextColumn, nextRow);
    visited.add(cellKey(nextColumn, nextRow));
    stack.push({ column: nextColumn, row: nextRow });
  }

  return grid;
};

interface PocketDraft {
  id: string;
  column: number;
  row: number;
  minColumn: number;
  maxColumn: number;
  minRow: number;
  maxRow: number;
}

const overlapsPocket = (draft: PocketDraft, existing: readonly PocketDraft[]): boolean =>
  existing.some(
    (pocket) =>
      draft.minColumn <= pocket.maxColumn + 2 &&
      draft.maxColumn + 2 >= pocket.minColumn &&
      draft.minRow <= pocket.maxRow + 2 &&
      draft.maxRow + 2 >= pocket.minRow
  );

const carvePockets = (grid: GridMatrix, columns: number, rows: number, rng: SeededRng): PocketDraft[] => {
  const candidates = oddInteriorCells(columns, rows).filter(({ column, row }) =>
    isFloorInGrid(grid, column, row)
  );
  const pocketTarget = clamp(Math.round((columns * rows) / 130) + 1, 3, 6);
  const pockets: PocketDraft[] = [];
  let attempts = 0;

  while (pockets.length < pocketTarget && attempts < pocketTarget * 40) {
    attempts += 1;
    const center = rng.pick(candidates);
    const halfColumns = rng.bool(0.35) ? 2 : 1;
    const halfRows = rng.bool(0.35) ? 2 : 1;
    const draft: PocketDraft = {
      id: `pocket-${pockets.length + 1}`,
      column: center.column,
      row: center.row,
      minColumn: center.column - halfColumns,
      maxColumn: center.column + halfColumns,
      minRow: center.row - halfRows,
      maxRow: center.row + halfRows
    };

    if (
      draft.minColumn <= 0 ||
      draft.minRow <= 0 ||
      draft.maxColumn >= columns - 1 ||
      draft.maxRow >= rows - 1 ||
      overlapsPocket(draft, pockets)
    ) {
      continue;
    }

    for (let row = draft.minRow; row <= draft.maxRow; row += 1) {
      for (let column = draft.minColumn; column <= draft.maxColumn; column += 1) {
        setFloor(grid, column, row);
      }
    }

    pockets.push(draft);
  }

  return pockets;
};

const carveLoops = (grid: GridMatrix, columns: number, rows: number, rng: SeededRng): void => {
  const candidates: Array<{ column: number; row: number }> = [];

  for (let row = 1; row < rows - 1; row += 1) {
    for (let column = 1; column < columns - 1; column += 1) {
      if (isFloorInGrid(grid, column, row)) continue;
      const horizontal = isFloorInGrid(grid, column - 1, row) && isFloorInGrid(grid, column + 1, row);
      const vertical = isFloorInGrid(grid, column, row - 1) && isFloorInGrid(grid, column, row + 1);
      if (horizontal || vertical) candidates.push({ column, row });
    }
  }

  const loopCount = clamp(Math.round((columns * rows) / 95), 2, 8);
  for (const opening of rng.shuffle(candidates).slice(0, loopCount)) {
    setFloor(grid, opening.column, opening.row);
  }
};

const toLayout = (grid: GridMatrix): string[] =>
  grid.map((row) => row.join(""));

const cellRect = (
  column: number,
  row: number,
  columnSpan: number,
  rowSpan: number,
  cellWidth: number,
  cellHeight: number
): ArenaRect => ({
  id: "",
  x: roundCoord(column * cellWidth),
  y: roundCoord(row * cellHeight),
  width: roundCoord(columnSpan * cellWidth),
  height: roundCoord(rowSpan * cellHeight),
  kind: "wall"
});

const buildCells = (
  layout: readonly string[],
  cellWidth: number,
  cellHeight: number,
  kind: GridTile
): ArenaGridCell[] => {
  const cells: ArenaGridCell[] = [];

  for (let row = 0; row < layout.length; row += 1) {
    const layoutRow = layout[row] ?? "";
    for (let column = 0; column < layoutRow.length; column += 1) {
      if (layoutRow.charAt(column) !== kind) continue;
      cells.push({
        column,
        row,
        x: roundCoord((column + 0.5) * cellWidth),
        y: roundCoord((row + 0.5) * cellHeight),
        width: roundCoord(cellWidth),
        height: roundCoord(cellHeight)
      });
    }
  }

  return cells;
};

const buildWallRects = (
  layout: readonly string[],
  columns: number,
  rows: number,
  cellWidth: number,
  cellHeight: number
): ArenaRect[] => {
  const visited = new Set<string>();
  const rects: ArenaRect[] = [];

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      if (!isFloorInLayout(layout, column, row) && !visited.has(cellKey(column, row))) {
        let columnSpan = 1;
        while (
          column + columnSpan < columns &&
          !isFloorInLayout(layout, column + columnSpan, row) &&
          !visited.has(cellKey(column + columnSpan, row))
        ) {
          columnSpan += 1;
        }

        let rowSpan = 1;
        let canExtend = true;
        while (row + rowSpan < rows && canExtend) {
          for (let offset = 0; offset < columnSpan; offset += 1) {
            if (
              isFloorInLayout(layout, column + offset, row + rowSpan) ||
              visited.has(cellKey(column + offset, row + rowSpan))
            ) {
              canExtend = false;
              break;
            }
          }
          if (canExtend) rowSpan += 1;
        }

        for (let yOffset = 0; yOffset < rowSpan; yOffset += 1) {
          for (let xOffset = 0; xOffset < columnSpan; xOffset += 1) {
            visited.add(cellKey(column + xOffset, row + yOffset));
          }
        }

        const rect = cellRect(column, row, columnSpan, rowSpan, cellWidth, cellHeight);
        rect.id = `wall-${column}-${row}-${columnSpan}x${rowSpan}`;
        rects.push(rect);
      }
    }
  }

  return rects;
};

const buildPockets = (
  drafts: readonly PocketDraft[],
  cellWidth: number,
  cellHeight: number
): ArenaPocket[] =>
  drafts.map((draft) => ({
    id: draft.id,
    column: draft.column,
    row: draft.row,
    columnSpan: draft.maxColumn - draft.minColumn + 1,
    rowSpan: draft.maxRow - draft.minRow + 1,
    x: roundCoord((draft.column + 0.5) * cellWidth),
    y: roundCoord((draft.row + 0.5) * cellHeight),
    width: roundCoord((draft.maxColumn - draft.minColumn + 1) * cellWidth),
    height: roundCoord((draft.maxRow - draft.minRow + 1) * cellHeight)
  }));

const neighborFloorCount = (
  layout: readonly string[],
  column: number,
  row: number
): number => {
  let count = 0;
  if (isFloorInLayout(layout, column + 1, row)) count += 1;
  if (isFloorInLayout(layout, column - 1, row)) count += 1;
  if (isFloorInLayout(layout, column, row + 1)) count += 1;
  if (isFloorInLayout(layout, column, row - 1)) count += 1;
  return count;
};

const isInsidePocket = (cell: ArenaGridCell, pockets: readonly ArenaPocket[]): boolean =>
  pockets.some((pocket) => {
    const minColumn = pocket.column - Math.floor(pocket.columnSpan / 2);
    const maxColumn = pocket.column + Math.floor(pocket.columnSpan / 2);
    const minRow = pocket.row - Math.floor(pocket.rowSpan / 2);
    const maxRow = pocket.row + Math.floor(pocket.rowSpan / 2);
    return cell.column >= minColumn && cell.column <= maxColumn && cell.row >= minRow && cell.row <= maxRow;
  });

const detectChokePoints = (arena: ArenaConfig, rng: SeededRng): ArenaChokePoint[] => {
  const candidates = arena.floorCells.filter((cell) => {
    if (isInsidePocket(cell, arena.pockets)) return false;
    const neighbors = neighborFloorCount(arena.grid.layout, cell.column, cell.row);
    return neighbors > 0 && neighbors <= 2;
  });
  const targetCount = clamp(Math.ceil(arena.playerCount * 1.5), 4, 12);
  const minCellSize = Math.min(arena.grid.cellWidth, arena.grid.cellHeight);

  return rng
    .shuffle(candidates)
    .slice(0, targetCount)
    .map((cell, index) => ({
      id: `choke-${index + 1}`,
      column: cell.column,
      row: cell.row,
      x: cell.x,
      y: cell.y,
      clearanceRadius: roundCoord(minCellSize * 0.35)
    }));
};

const circleIntersectsRect = (x: number, y: number, radius: number, rect: ArenaRect): boolean => {
  const closestX = clamp(x, rect.x, rect.x + rect.width);
  const closestY = clamp(y, rect.y, rect.y + rect.height);
  return Math.hypot(x - closestX, y - closestY) <= radius;
};

const isOutsideArena = (arena: Pick<ArenaConfig, "width" | "height">, x: number, y: number, radius: number): boolean =>
  x - radius < 0 || y - radius < 0 || x + radius > arena.width || y + radius > arena.height;

const isClearPoint = (
  arena: Pick<ArenaConfig, "width" | "height" | "collisionRects">,
  x: number,
  y: number,
  radius: number
): boolean =>
  !isOutsideArena(arena, x, y, radius) &&
  arena.collisionRects.every((rect) => !circleIntersectsRect(x, y, radius, rect));

const selectSpawnPoints = (arena: ArenaConfig, rng: SeededRng): ArenaSpawnPoint[] => {
  const spawnCount = arena.playerCount;
  const minCellSize = Math.min(arena.grid.cellWidth, arena.grid.cellHeight);
  const radius = roundCoord(minCellSize * 0.26);
  const center = { x: arena.width / 2, y: arena.height / 2 };
  const phase = rng.float(0, Math.PI * 2);
  const candidates = arena.floorCells.filter((cell) => isClearPoint(arena, cell.x, cell.y, radius));
  const selected: ArenaGridCell[] = [];
  const selectedKeys = new Set<string>();
  const minDesiredDistance = Math.min(arena.width, arena.height) * (spawnCount <= 4 ? 0.28 : 0.16);

  for (let slot = 0; slot < spawnCount; slot += 1) {
    const angle = phase + (Math.PI * 2 * slot) / spawnCount;
    const target = {
      x: center.x + Math.cos(angle) * arena.width * 0.38,
      y: center.y + Math.sin(angle) * arena.height * 0.38
    };
    let bestCell: ArenaGridCell | undefined;
    let bestScore = -Infinity;

    for (const cell of candidates) {
      if (selectedKeys.has(cellKey(cell.column, cell.row))) continue;
      const distanceToTarget = distance(cell, target);
      const distanceFromCenter = distance(cell, center);
      const nearestSpawnDistance =
        selected.length === 0 ? minDesiredDistance : Math.min(...selected.map((spawn) => distance(cell, spawn)));
      const closePenalty =
        nearestSpawnDistance < minDesiredDistance ? (minDesiredDistance - nearestSpawnDistance) * 4 : 0;
      const score =
        nearestSpawnDistance * 0.9 +
        distanceFromCenter * 0.2 -
        distanceToTarget -
        closePenalty +
        rng.float(0, 0.001);

      if (score > bestScore) {
        bestScore = score;
        bestCell = cell;
      }
    }

    if (!bestCell) break;
    selected.push(bestCell);
    selectedKeys.add(cellKey(bestCell.column, bestCell.row));
  }

  return selected.map((cell, index) => ({
    id: `spawn-${index + 1}`,
    playerSlot: index,
    x: cell.x,
    y: cell.y,
    radius,
    rotation: roundCoord(Math.atan2(center.y - cell.y, center.x - cell.x))
  }));
};

const selectPickupPlacements = (arena: ArenaConfig, rng: SeededRng): ArenaPickupPlacement[] => {
  const minCellSize = Math.min(arena.grid.cellWidth, arena.grid.cellHeight);
  const radius = roundCoord(minCellSize * 0.22);
  const pickupCount = clamp(Math.max(PICKUP_TYPES.length, Math.ceil(arena.playerCount * 1.5)), 6, 14);
  const shuffledTypes = rng.shuffle(PICKUP_TYPES);
  const clearCandidates = arena.floorCells.filter((cell) => isClearPoint(arena, cell.x, cell.y, radius));
  const spawnClearance = minCellSize * 1.7;
  const pickupClearance = minCellSize * 1.55;
  const selected: ArenaGridCell[] = [];
  const selectedKeys = new Set<string>();

  const candidates = clearCandidates.filter((cell) =>
    arena.spawnPoints.every((spawn) => distance(cell, spawn) > spawn.radius + radius + spawnClearance)
  );
  const usableCandidates = candidates.length >= pickupCount ? candidates : clearCandidates;

  for (let index = 0; index < pickupCount; index += 1) {
    let bestCell: ArenaGridCell | undefined;
    let bestScore = -Infinity;

    for (const cell of usableCandidates) {
      if (selectedKeys.has(cellKey(cell.column, cell.row))) continue;
      const nearestPickupDistance =
        selected.length === 0 ? pickupClearance : Math.min(...selected.map((pickup) => distance(cell, pickup)));
      const nearestSpawnDistance =
        arena.spawnPoints.length === 0
          ? spawnClearance
          : Math.min(...arena.spawnPoints.map((spawn) => distance(cell, spawn)));
      const pickupPenalty =
        nearestPickupDistance < pickupClearance ? (pickupClearance - nearestPickupDistance) * 6 : 0;
      const spawnPenalty =
        nearestSpawnDistance < spawnClearance ? (spawnClearance - nearestSpawnDistance) * 3 : 0;
      const score =
        nearestPickupDistance * 0.75 +
        nearestSpawnDistance * 0.2 -
        pickupPenalty -
        spawnPenalty +
        rng.float(0, 0.001);

      if (score > bestScore) {
        bestScore = score;
        bestCell = cell;
      }
    }

    if (!bestCell) break;
    selected.push(bestCell);
    selectedKeys.add(cellKey(bestCell.column, bestCell.row));
  }

  return selected.map((cell, index) => {
    const pickupType = shuffledTypes[index % shuffledTypes.length] as PickupType;
    const config = PICKUP_CONFIG[pickupType];
    return {
      id: `pickup-${index + 1}-${pickupType}`,
      pickupType,
      x: cell.x,
      y: cell.y,
      radius,
      value: config.value,
      durationMs: config.durationMs,
      respawnMs: config.respawnMs
    };
  });
};

const zoneAnchor = (
  arena: ArenaConfig,
  rng: SeededRng,
  previous?: ArenaPoint
): ArenaPoint => {
  const center = { x: arena.width / 2, y: arena.height / 2 };
  const maxDistance = Math.min(arena.width, arena.height) * 0.34;
  const candidates = arena.floorCells.filter((cell) => distance(cell, center) <= maxDistance);
  const usable = candidates.length > 0 ? candidates : arena.floorCells;
  const shuffled = rng.shuffle(usable);
  const anchor =
    previous === undefined
      ? shuffled[0]
      : shuffled.find((cell) => distance(cell, previous) > Math.min(arena.width, arena.height) * 0.12) ?? shuffled[0];

  return anchor ? { x: anchor.x, y: anchor.y } : center;
};

export const planZonePhases = (arena: ArenaConfig, now = 0): ZonePlan[] => {
  const startsAt = Number.isFinite(now) ? Math.max(0, Math.round(now)) : 0;
  const rng = createSeededRng(`${arena.seed}:zone`);
  const center = { x: roundCoord(arena.width / 2), y: roundCoord(arena.height / 2) };
  const dangerCenter = zoneAnchor(arena, rng);
  const finalCenter = zoneAnchor(arena, rng, dangerCenter);
  const minDimension = Math.min(arena.width, arena.height);
  const initialRadius = roundCoord(Math.hypot(arena.width, arena.height) * 0.56);
  const dangerRadius = roundCoord(minDimension * 0.38);
  const finalRadius = roundCoord(minDimension * 0.18);
  const suddenDeathRadius = roundCoord(minDimension * 0.07);

  return [
    {
      index: 0,
      matchState: "running",
      startsAt,
      warningAt: startsAt + 60_000,
      closesAt: startsAt + 90_000,
      x: center.x,
      y: center.y,
      radius: initialRadius,
      targetX: dangerCenter.x,
      targetY: dangerCenter.y,
      targetRadius: dangerRadius,
      damagePerSecond: 0
    },
    {
      index: 1,
      matchState: "danger",
      startsAt: startsAt + 90_000,
      warningAt: startsAt + 120_000,
      closesAt: startsAt + 150_000,
      x: dangerCenter.x,
      y: dangerCenter.y,
      radius: dangerRadius,
      targetX: finalCenter.x,
      targetY: finalCenter.y,
      targetRadius: finalRadius,
      damagePerSecond: 8
    },
    {
      index: 2,
      matchState: "final_zone",
      startsAt: startsAt + 150_000,
      warningAt: startsAt + 180_000,
      closesAt: startsAt + 210_000,
      x: finalCenter.x,
      y: finalCenter.y,
      radius: finalRadius,
      targetX: finalCenter.x,
      targetY: finalCenter.y,
      targetRadius: suddenDeathRadius,
      damagePerSecond: 18
    }
  ];
};

export const planArenaWeather = (seed: string, rng = createSeededRng(seed).fork("weather")): ArenaWeatherConfig => {
  const isRaining = rng.bool(0.7);
  return {
    kind: isRaining ? "rain" : "clear",
    intensity: isRaining ? roundCoord(rng.float(0.62, 0.94)) : 0,
    seed: `${seed}:weather`
  };
};

export const generateArenaConfig = (options: ArenaGenerationOptions): ArenaConfig => {
  const seed = options.seed.trim() || "alpha7-arena";
  const playerCount = normalizePlayerCount(options.playerCount);
  const width = normalizeDimension(options.width, DEFAULT_ARENA_WIDTH, MIN_GRID_COLUMNS * TARGET_CELL_SIZE);
  const height = normalizeDimension(options.height, DEFAULT_ARENA_HEIGHT, MIN_GRID_ROWS * TARGET_CELL_SIZE);
  const columns = oddGridCount(width, MIN_GRID_COLUMNS);
  const rows = oddGridCount(height, MIN_GRID_ROWS);
  const cellWidth = width / columns;
  const cellHeight = height / rows;
  const rng = createSeededRng(seed);
  const grid = carveMaze(columns, rows, rng.fork("maze"));
  const pocketDrafts = carvePockets(grid, columns, rows, rng.fork("pockets"));
  carveLoops(grid, columns, rows, rng.fork("loops"));

  const layout = toLayout(grid);
  const wallRects = buildWallRects(layout, columns, rows, cellWidth, cellHeight);
  const collisionRects = wallRects.map((rect) => ({
    ...rect,
    id: rect.id.replace("wall-", "collision-"),
    kind: "collision" as const
  }));

  const arena: ArenaConfig = {
    version: ARENA_CONFIG_VERSION,
    seed,
    playerCount,
    width: roundCoord(width),
    height: roundCoord(height),
    grid: {
      columns,
      rows,
      cellWidth: roundCoord(cellWidth),
      cellHeight: roundCoord(cellHeight),
      layout
    },
    floorCells: buildCells(layout, cellWidth, cellHeight, "."),
    wallCells: buildCells(layout, cellWidth, cellHeight, "#"),
    wallRects,
    collisionRects,
    pockets: buildPockets(pocketDrafts, cellWidth, cellHeight),
    chokePoints: [],
    spawnPoints: [],
    pickupPlacements: [],
    zonePhases: [],
    weather: planArenaWeather(seed, rng.fork("weather"))
  };

  arena.chokePoints = detectChokePoints(arena, rng.fork("chokes"));
  arena.spawnPoints = selectSpawnPoints(arena, rng.fork("spawns"));
  arena.pickupPlacements = selectPickupPlacements(arena, rng.fork("pickups"));
  arena.zonePhases = planZonePhases(arena, 0);

  return arena;
};

export const validateArenaConnectivity = (arena: ArenaConfig): ArenaConnectivityResult => {
  const floorCount = arena.floorCells.length;
  const start = arena.floorCells[0];
  if (!start) {
    return { ok: false, reachableFloorCount: 0, floorCount };
  }

  const floorKeys = new Set(arena.floorCells.map((cell) => cellKey(cell.column, cell.row)));
  const visited = new Set<string>();
  const queue = [{ column: start.column, row: start.row }];
  visited.add(cellKey(start.column, start.row));

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;

    for (const next of [
      { column: current.column + 1, row: current.row },
      { column: current.column - 1, row: current.row },
      { column: current.column, row: current.row + 1 },
      { column: current.column, row: current.row - 1 }
    ]) {
      const key = cellKey(next.column, next.row);
      if (!floorKeys.has(key) || visited.has(key)) continue;
      visited.add(key);
      queue.push(next);
    }
  }

  return {
    ok: visited.size === floorCount,
    reachableFloorCount: visited.size,
    floorCount
  };
};

export const isWallCollision = (arena: ArenaConfig, x: number, y: number, radius: number): boolean => {
  const safeRadius = Math.max(0, radius);
  if (isOutsideArena(arena, x, y, safeRadius)) return true;
  return arena.collisionRects.some((rect) => circleIntersectsRect(x, y, safeRadius, rect));
};

export const clampToArena = (
  arena: ArenaConfig,
  x: number,
  y: number,
  radius: number
): ArenaPoint => {
  const safeRadius = Math.max(0, radius);
  const clamped = {
    x: roundCoord(clamp(x, safeRadius, arena.width - safeRadius)),
    y: roundCoord(clamp(y, safeRadius, arena.height - safeRadius))
  };

  if (!isWallCollision(arena, clamped.x, clamped.y, safeRadius)) return clamped;

  let nearest: ArenaPoint | undefined;
  let nearestDistance = Infinity;
  for (const cell of arena.floorCells) {
    if (isWallCollision(arena, cell.x, cell.y, safeRadius)) continue;
    const candidateDistance = Math.hypot(cell.x - clamped.x, cell.y - clamped.y);
    if (candidateDistance < nearestDistance) {
      nearestDistance = candidateDistance;
      nearest = { x: cell.x, y: cell.y };
    }
  }

  return nearest ?? clamped;
};
