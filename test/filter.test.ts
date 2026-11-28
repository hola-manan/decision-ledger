import { test } from "node:test";
import assert from "node:assert/strict";
import { clampRange, GradeFilter, isFilterActive, matchesRanges, restoreRanges, type GradeRanges } from "../src/filter/grade-filter";
import { parseFilterHostMessage, parseFilterMessage } from "../src/protocol";

const SCALE = { min: 1, max: 5 };
const IDS = ["codeSpan", "reversibility"];

function memoryStore(initial?: unknown) {
  let saved = initial;
  return { get: () => saved, set: (ranges: GradeRanges) => (saved = ranges), saved: () => saved };
}

test("full ranges show everything, including ungraded records", () => {
  const ranges = restoreRanges(undefined, IDS, SCALE);
  assert.equal(isFilterActive(ranges, SCALE), false);
  assert.equal(matchesRanges({}, ranges, SCALE), true);
  assert.equal(matchesRanges({ codeSpan: 1, reversibility: 5 }, ranges, SCALE), true);
});

test("a record is shown only if every narrowed grade fits, both ends included", () => {
  const ranges = { codeSpan: { min: 3, max: 5 }, reversibility: { min: 1, max: 2 } };
  assert.equal(matchesRanges({ codeSpan: 3, reversibility: 2 }, ranges, SCALE), true);
  assert.equal(matchesRanges({ codeSpan: 5, reversibility: 1 }, ranges, SCALE), true);
  assert.equal(matchesRanges({ codeSpan: 2, reversibility: 1 }, ranges, SCALE), false);
  assert.equal(matchesRanges({ codeSpan: 4, reversibility: 3 }, ranges, SCALE), false);
});

test("a record without a grade for a narrowed parameter is hidden; un-narrowed ones don't matter", () => {
  const ranges = { codeSpan: { min: 3, max: 5 }, reversibility: { ...SCALE } };
  assert.equal(matchesRanges({ reversibility: 4 }, ranges, SCALE), false);
  assert.equal(matchesRanges({ codeSpan: 4 }, ranges, SCALE), true);
});

test("restoring keeps saved ranges, clamps them, drops unknown parameters and fills new ones", () => {
  const saved = { codeSpan: { min: 0, max: 3.6 }, removedParameter: { min: 2, max: 3 } };
  assert.deepEqual(restoreRanges(saved, IDS, SCALE), { codeSpan: { min: 1, max: 4 }, reversibility: { min: 1, max: 5 } });
});

test("restoring ignores saved values that aren't ranges", () => {
  for (const saved of [null, "x", [], { codeSpan: "3-5" }, { codeSpan: { min: Number.NaN, max: 4 } }, { codeSpan: { min: 2 } }]) {
    assert.deepEqual(restoreRanges(saved, ["codeSpan"], SCALE), { codeSpan: { min: 1, max: 5 } }, JSON.stringify(saved));
  }
});

test("clamping snaps to whole grades and never lets the handles cross", () => {
  assert.deepEqual(clampRange({ min: 2.4, max: 9 }, SCALE), { min: 2, max: 5 });
  assert.deepEqual(clampRange({ min: 4, max: 2 }, SCALE), { min: 2, max: 4 });
  assert.deepEqual(clampRange({ min: 3, max: 3 }, SCALE), { min: 3, max: 3 });
});

test("GradeFilter saves every change, tells the view, and resets to full ranges", () => {
  const store = memoryStore();
  let changes = 0;
  const filter = new GradeFilter(store, SCALE, () => changes++);
  filter.syncParameters(IDS);
  filter.setRange("reversibility", { min: 1, max: 2 });
  assert.equal(filter.isActive, true);
  assert.equal(changes, 1);
  assert.deepEqual(store.saved(), { codeSpan: { min: 1, max: 5 }, reversibility: { min: 1, max: 2 } });
  assert.equal(filter.shows({ codeSpan: 5, reversibility: 3 }), false);
  filter.reset();
  assert.equal(filter.isActive, false);
  assert.equal(changes, 2);
  assert.deepEqual(store.saved(), {});
  assert.deepEqual(filter.ranges, { codeSpan: { min: 1, max: 5 }, reversibility: { min: 1, max: 5 } });
});

test("GradeFilter ignores a range for a parameter that isn't current", () => {
  const store = memoryStore();
  let changes = 0;
  const filter = new GradeFilter(store, SCALE, () => changes++);
  filter.syncParameters(IDS);
  for (const id of ["notAParameter", "toString", "constructor", "__proto__"]) filter.setRange(id, { min: 2, max: 3 });
  assert.equal(changes, 0);
  assert.equal(store.saved(), undefined);
});

test("GradeFilter is remembered: a new instance restores the saved ranges", () => {
  const store = memoryStore();
  const first = new GradeFilter(store, SCALE, () => {});
  first.syncParameters(IDS);
  first.setRange("codeSpan", { min: 3, max: 5 });
  const second = new GradeFilter(store, SCALE, () => {});
  second.syncParameters(IDS);
  assert.deepEqual(second.ranges.codeSpan, { min: 3, max: 5 });
});

test("with no current parameters (broken config) the filter is off but the saved ranges are kept", () => {
  const store = memoryStore({ codeSpan: { min: 3, max: 5 } });
  const filter = new GradeFilter(store, SCALE, () => {});
  filter.syncParameters([]);
  assert.equal(filter.isActive, false);
  assert.equal(filter.shows({}), true);
  filter.syncParameters(IDS);
  assert.deepEqual(filter.ranges.codeSpan, { min: 3, max: 5 });
});

test("parseFilterMessage accepts each message and rejects anything else", () => {
  assert.deepEqual(parseFilterMessage({ type: "ready" }), { type: "ready" });
  assert.deepEqual(parseFilterMessage({ type: "reset", extra: 1 }), { type: "reset" });
  assert.deepEqual(parseFilterMessage({ type: "editParameters" }), { type: "editParameters" });
  assert.deepEqual(parseFilterMessage({ type: "setRange", id: "codeSpan", range: { min: 2, max: 4 } }), {
    type: "setRange",
    id: "codeSpan",
    range: { min: 2, max: 4 },
  });
  for (const bad of [
    null,
    "ready",
    [],
    { type: "delete" },
    { type: "setRange", id: "", range: { min: 2, max: 4 } },
    { type: "setRange", id: "codeSpan", range: { min: 2.5, max: 4 } },
    { type: "setRange", id: "codeSpan", range: [2, 4] },
    { type: "setRange", id: 7, range: { min: 2, max: 4 } },
  ]) {
    assert.equal(parseFilterMessage(bad), undefined, JSON.stringify(bad));
  }
});

test("setRange keeps saved ranges of parameters missing from config right now", () => {
  const store = memoryStore({ removedForNow: { min: 2, max: 3 } });
  const filter = new GradeFilter(store, SCALE, () => {});
  filter.syncParameters(IDS);
  filter.setRange("codeSpan", { min: 4, max: 5 });
  assert.deepEqual(store.saved(), { removedForNow: { min: 2, max: 3 }, codeSpan: { min: 4, max: 5 }, reversibility: { min: 1, max: 5 } });
});

test("a saved range under a prototype name never narrows anything", () => {
  const filter = new GradeFilter(memoryStore(JSON.parse('{"__proto__": {"min": 2, "max": 2}}')), SCALE, () => {});
  filter.syncParameters(["codeSpan"]);
  assert.equal(filter.isActive, false);
  assert.equal(matchesRanges({}, { toString: { min: 2, max: 3 } } as GradeRanges, SCALE), false, "a missing grade fails a narrowed range");
  assert.equal(matchesRanges({ codeSpan: 3 }, { codeSpan: { min: 2, max: 3 } }, SCALE), true);
});

test("nodes: kept while the filter is off; with it on, only nodes with a shown record; counts cover every record", () => {
  const filter = new GradeFilter(memoryStore(), SCALE, () => {});
  filter.syncParameters(IDS);
  const nodes = [[{ codeSpan: 1, reversibility: 1 }], [{ codeSpan: 4, reversibility: 2 }, { codeSpan: 2, reversibility: 5 }], []];
  let loads = 0;
  const load = (n: Record<string, number>[]) => () => (loads++, n);
  assert.deepEqual(nodes.map((n) => filter.showsAny(load(n))), [true, true, true]);
  assert.equal(loads, 0, "records aren't read while the filter is off");
  filter.setRange("codeSpan", { min: 3, max: 5 });
  assert.deepEqual(nodes.map((n) => filter.showsAny(load(n))), [false, true, false]);
  assert.deepEqual(filter.count(nodes.flat()), { shown: 1, total: 3 });
});

test("parseFilterHostMessage accepts a state and an error, and rejects malformed ones", () => {
  const state = {
    type: "state",
    scale: { min: 1, max: 5 },
    parameters: [{ id: "codeSpan", name: "Code span", low: "line", extra: true }],
    ranges: { codeSpan: { min: 2, max: 4 } },
    isActive: true,
    shown: 3,
    total: 9,
  };
  assert.deepEqual(parseFilterHostMessage(state), { ...state, parameters: [{ id: "codeSpan", name: "Code span", low: "line" }] });
  assert.deepEqual(parseFilterHostMessage({ type: "error", message: "bad" }), { type: "error", message: "bad" });
  for (const bad of [
    null,
    { type: "error" },
    { ...state, scale: { min: 1 } },
    { ...state, parameters: [{ id: "codeSpan" }] },
    { ...state, ranges: {} },
    { ...state, ranges: { codeSpan: { min: "2", max: 4 } } },
    { ...state, isActive: "yes" },
    { ...state, shown: 1.5 },
    { type: "snapshot" },
  ]) {
    assert.equal(parseFilterHostMessage(bad), undefined, JSON.stringify(bad));
  }
});
