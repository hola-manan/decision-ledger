import type { DecisionRecord, Ledger, ParameterSet } from "./store";

export interface NamedGrade {
  name: string;
  grade: number;
  low?: string;
  high?: string;
}

/** Each grade with its parameter's name, as it was defined when the record was graded. */
export function namedGrades(ledger: Ledger, r: DecisionRecord): NamedGrade[] {
  const definitions = r.parameterSet ? ledger.get<ParameterSet>(r.parameterSet).parameters : [];
  return Object.entries(r.grades).map(([id, grade]) => {
    const definition = definitions.find((p) => p.id === id);
    return { name: definition?.name ?? id, grade, low: definition?.low, high: definition?.high };
  });
}
