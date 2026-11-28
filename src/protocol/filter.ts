/**
 * The Filter view's messages (D-021, api.md "Filter view"). No vscode, no DOM: compiled
 * into the extension and into the webview, and validated at both edges.
 */

/** Both ends included. */
export interface GradeRange {
  min: number;
  max: number;
}

export interface FilterParameter {
  id: string;
  name: string;
  low?: string;
  high?: string;
}

export interface FilterState {
  type: "state";
  scale: GradeRange;
  parameters: FilterParameter[];
  /** Parameter id → selected range; every parameter has one. */
  ranges: Record<string, GradeRange>;
  /** Whether any range is narrowed (decided by the extension, not recomputed here). */
  isActive: boolean;
  shown: number;
  total: number;
}

export type FilterHostMessage = FilterState | { type: "error"; message: string };

export type FilterWebviewMessage =
  | { type: "ready" }
  | { type: "setRange"; id: string; range: GradeRange }
  | { type: "reset" }
  | { type: "editParameters" };

/** Validates a message from the webview; undefined if it isn't one. */
export function parseFilterMessage(value: unknown): FilterWebviewMessage | undefined {
  if (!isObject(value)) return undefined;
  switch (value.type) {
    case "ready":
    case "reset":
    case "editParameters":
      return { type: value.type };
    case "setRange": {
      const range = asRange(value.range);
      return typeof value.id === "string" && value.id && range ? { type: "setRange", id: value.id, range } : undefined;
    }
    default:
      return undefined;
  }
}

/** Validates a message from the extension; undefined if it isn't one. */
export function parseFilterHostMessage(value: unknown): FilterHostMessage | undefined {
  if (!isObject(value)) return undefined;
  if (value.type === "error") return typeof value.message === "string" ? { type: "error", message: value.message } : undefined;
  if (value.type !== "state") return undefined;
  const scale = asRange(value.scale);
  const parameters = Array.isArray(value.parameters) ? value.parameters.map(asParameter) : [];
  const ranges = isObject(value.ranges) ? value.ranges : {};
  if (!scale || parameters.some((p) => !p) || typeof value.isActive !== "boolean") return undefined;
  if (!Number.isInteger(value.shown) || !Number.isInteger(value.total)) return undefined;
  const checked: Record<string, GradeRange> = {};
  for (const p of parameters as FilterParameter[]) {
    const range = Object.hasOwn(ranges, p.id) ? asRange(ranges[p.id]) : undefined;
    if (!range) return undefined;
    checked[p.id] = range;
  }
  const { isActive, shown, total } = value as { isActive: boolean; shown: number; total: number };
  return { type: "state", scale, parameters: parameters as FilterParameter[], ranges: checked, isActive, shown, total };
}

function asRange(value: unknown): GradeRange | undefined {
  if (!isObject(value) || !Number.isInteger(value.min) || !Number.isInteger(value.max)) return undefined;
  return { min: value.min as number, max: value.max as number };
}

function asParameter(value: unknown): FilterParameter | undefined {
  if (!isObject(value) || typeof value.id !== "string" || typeof value.name !== "string") return undefined;
  const parameter: FilterParameter = { id: value.id, name: value.name };
  if (typeof value.low === "string") parameter.low = value.low;
  if (typeof value.high === "string") parameter.high = value.high;
  return parameter;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
