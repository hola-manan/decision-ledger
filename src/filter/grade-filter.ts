/**
 * Which grades the decisions view shows (D-021). View-only: nothing here changes what is
 * extracted or stored. No vscode, so it is unit-tested directly.
 */
import type { GradeRange } from "../protocol";

/** Parameter id → selected range. A parameter with no entry shows every grade. */
export type GradeRanges = Record<string, GradeRange>;

/** Where the ranges are saved between sessions (VS Code's workspaceState in the extension). */
export interface RangeStore {
  get(): unknown;
  set(ranges: GradeRanges): void;
}

export interface DecisionCounts {
  shown: number;
  total: number;
}

type Grades = Record<string, number>;

/** The current ranges, kept in step with the current parameters and saved on every change. */
export class GradeFilter {
  private current: GradeRanges = {};

  /** `onChange` runs after setRange and reset, never during construction. */
  constructor(
    private readonly store: RangeStore,
    readonly scale: GradeRange,
    private readonly onChange: () => void
  ) {}

  get ranges(): GradeRanges {
    return this.current;
  }

  get isActive(): boolean {
    return isFilterActive(this.current, this.scale);
  }

  /** Re-reads the saved ranges for these parameters. An empty list turns the filter off without forgetting them. */
  syncParameters(parameterIds: string[]): void {
    this.current = restoreRanges(this.store.get(), parameterIds, this.scale);
  }

  shows(grades: Grades): boolean {
    return matchesRanges(grades, this.current, this.scale);
  }

  /**
   * Whether a node stays in the view: always while the filter is off, else if any of its
   * records is shown. The records' grades are loaded only when the filter is on.
   */
  showsAny(loadGrades: () => Grades[]): boolean {
    return !this.isActive || loadGrades().some((grades) => this.shows(grades));
  }

  count(gradesOfRecords: Grades[]): DecisionCounts {
    return { shown: gradesOfRecords.filter((grades) => this.shows(grades)).length, total: gradesOfRecords.length };
  }

  /** Ignored for a parameter that isn't current. Saved ranges of parameters missing from config right now are kept. */
  setRange(id: string, range: GradeRange): void {
    if (!Object.hasOwn(this.current, id)) return;
    this.current = { ...this.current, [id]: clampRange(range, this.scale) };
    this.store.set({ ...savedRanges(this.store.get()), ...this.current } as GradeRanges);
    this.onChange();
  }

  /** Shows every grade again and forgets every saved range. */
  reset(): void {
    this.current = fullRanges(Object.keys(this.current), this.scale);
    this.store.set({});
    this.onChange();
  }
}

/** Whether a range hides anything on this scale. */
export function isNarrowed(range: GradeRange, scale: GradeRange): boolean {
  return range.min > scale.min || range.max < scale.max;
}

export function isFilterActive(ranges: GradeRanges, scale: GradeRange): boolean {
  return Object.values(ranges).some((range) => isNarrowed(range, scale));
}

/**
 * Whether a record with these grades is shown: its grade fits every narrowed range.
 * A record with no grade for a narrowed parameter is hidden.
 */
export function matchesRanges(grades: Grades, ranges: GradeRanges, scale: GradeRange): boolean {
  return Object.entries(ranges).every(([id, range]) => {
    if (!isNarrowed(range, scale)) return true;
    const grade = Object.hasOwn(grades, id) ? grades[id] : undefined;
    return typeof grade === "number" && grade >= range.min && grade <= range.max;
  });
}

/** One range per current parameter: saved ones kept (clamped), unknown ids dropped, missing ones full. */
export function restoreRanges(saved: unknown, parameterIds: string[], scale: GradeRange): GradeRanges {
  const ranges = savedRanges(saved);
  return Object.fromEntries(parameterIds.map((id) => [id, toRange(Object.hasOwn(ranges, id) ? ranges[id] : undefined, scale)]));
}

/** The range snapped to whole grades and clamped to the scale; handles never cross. */
export function clampRange(range: GradeRange, scale: GradeRange): GradeRange {
  const min = clampGrade(range.min, scale);
  const max = clampGrade(range.max, scale);
  return min <= max ? { min, max } : { min: max, max: min };
}

export function fullRanges(parameterIds: string[], scale: GradeRange): GradeRanges {
  return Object.fromEntries(parameterIds.map((id) => [id, { ...scale }]));
}

function savedRanges(saved: unknown): Record<string, unknown> {
  return isObject(saved) ? saved : {};
}

function toRange(value: unknown, scale: GradeRange): GradeRange {
  if (!isObject(value) || !Number.isFinite(value.min) || !Number.isFinite(value.max)) return { ...scale };
  return clampRange({ min: value.min as number, max: value.max as number }, scale);
}

function clampGrade(grade: number, scale: GradeRange): number {
  return Math.min(scale.max, Math.max(scale.min, Math.round(grade)));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
