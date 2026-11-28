/**
 * Tiny hand-written checks for protocol messages (D-013: no schema library). Each check
 * returns a fresh value with unknown fields dropped, or throws InvalidMessage saying
 * where and what was wrong. Compiled into the extension and the webview, so imports in
 * src/protocol/ carry explicit .js extensions.
 */

export class InvalidMessage extends Error {}

/** `at` is where the value sits, e.g. "exchange.response.files[2].path". */
export type Check<T> = (value: unknown, at: string) => T;

type Shape = Record<string, Check<unknown>>;

/** The type a check produces. */
export type Checked<C> = C extends Check<infer T> ? T : never;

/** true when A and B are each assignable to the other. */
export type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type FromShape<S extends Shape> = { [K in keyof S]: S[K] extends Check<infer T> ? T : never };

function fail(at: string, expected: string, value: unknown): never {
  throw new InvalidMessage(`${at}: expected ${expected}, got ${describe(value)}`);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "string" ? `"${value.slice(0, 40)}"` : typeof value;
}

export const str: Check<string> = (value, at) => (typeof value === "string" ? value : fail(at, "a string", value));

export const nonEmptyStr: Check<string> = (value, at) => (typeof value === "string" && value.length > 0 ? value : fail(at, "a non-empty string", value));

export const num: Check<number> = (value, at) => (typeof value === "number" && Number.isFinite(value) ? value : fail(at, "a number", value));

export const int: Check<number> = (value, at) => (Number.isInteger(value) ? (value as number) : fail(at, "a whole number", value));

export const bool: Check<boolean> = (value, at) => (typeof value === "boolean" ? value : fail(at, "true or false", value));

export function literal<const T extends string | number>(...allowed: T[]): Check<T> {
  return (value, at) => (allowed.includes(value as T) ? (value as T) : fail(at, allowed.map((a) => JSON.stringify(a)).join(" or "), value));
}

export function nullable<T>(check: Check<T>): Check<T | null> {
  return (value, at) => (value === null ? null : check(value, at));
}

export function array<T>(check: Check<T>): Check<T[]> {
  return (value, at) => (Array.isArray(value) ? value.map((item, i) => check(item, `${at}[${i}]`)) : fail(at, "an array", value));
}

/** Every listed field must be present; others are dropped. */
export function object<S extends Shape>(shape: S): Check<FromShape<S>> {
  return (value, at) => {
    if (!isPlainObject(value)) return fail(at, "an object", value);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(shape)) {
      if (!Object.hasOwn(value, key)) throw new InvalidMessage(`${at}.${key}: missing`);
      out[key] = shape[key](value[key], `${at}.${key}`);
    }
    return out as FromShape<S>;
  };
}

/** A map with string keys; each value checked. */
export function record<T>(check: Check<T>): Check<Record<string, T>> {
  return (value, at) => {
    if (!isPlainObject(value)) return fail(at, "an object", value);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, check(item, `${at}.${key}`)]));
  };
}

/** Each variant's checked fields plus its tag. */
type Tagged<K extends string, M extends Record<string, Check<object>>> = { [T in keyof M & string]: { [k in K]: T } & ReturnType<M[T]> }[keyof M & string];

/** One of several object shapes, chosen by a string field (e.g. "type"). */
export function tagged<K extends string, M extends Record<string, Check<object>>>(key: K, variants: M): Check<Tagged<K, M>> {
  return (value, at) => {
    if (!isPlainObject(value)) return fail(at, "an object", value);
    const tag = value[key];
    if (typeof tag !== "string" || !Object.hasOwn(variants, tag)) return fail(`${at}.${key}`, Object.keys(variants).join(" or "), tag);
    return { [key]: tag, ...variants[tag](value, at) } as Tagged<K, M>;
  };
}

export const scalar: Check<string | number | boolean> = (value, at) =>
  typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))
    ? value
    : fail(at, "a string, number or true/false", value);

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
