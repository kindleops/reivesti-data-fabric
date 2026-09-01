// Registry query surface and integrity rules.
import { fail } from '../core/errors.ts';
import { assertRolePermitted } from './policy.ts';
import { JURISDICTIONS, NATION_ID, getJurisdiction, stateJurisdictionId } from './jurisdictions.ts';
import type {
  Capability,
  Jurisdiction,
  JurisdictionScope,
  SourceDefinition,
  SourceJurisdictionMapping,
} from './types.ts';

export type Registry = {
  readonly sources: readonly SourceDefinition[];
  readonly mappings: readonly SourceJurisdictionMapping[];
  readonly jurisdictions: readonly Jurisdiction[];
  source(sourceId: string): SourceDefinition;
  mapping(mappingId: string): SourceJurisdictionMapping;
  mappingsForSource(sourceId: string): readonly SourceJurisdictionMapping[];
  /** Every concrete jurisdiction a mapping covers, expanded from its scope. */
  expand(mapping: SourceJurisdictionMapping): readonly Jurisdiction[];
  /** Sources that can supply a capability somewhere in a jurisdiction. */
  sourcesFor(jurisdictionId: string, capability: Capability): readonly SourceDefinition[];
};

export function createRegistry(
  sources: readonly SourceDefinition[],
  mappings: readonly SourceJurisdictionMapping[],
  jurisdictions: readonly Jurisdiction[] = JURISDICTIONS,
): Registry {
  const byId = new Map<string, SourceDefinition>();
  for (const s of sources) {
    if (byId.has(s.sourceId)) fail('CONFIG', `duplicate sourceId "${s.sourceId}" in registry`);
    if (s.sourcePriority < 1) fail('CONFIG', `source "${s.sourceId}" has a non-positive priority`);
    // The zero-cost doctrine, enforced where sources are assembled rather than
    // only where they are evaluated. Mirrors sources_core_role_is_zero_cost in
    // migration 0007: a source may not even be DECLARED core until it is known
    // to be free.
    assertRolePermitted(s);
    byId.set(s.sourceId, s);
  }

  const mapById = new Map<string, SourceJurisdictionMapping>();
  for (const m of mappings) {
    if (mapById.has(m.mappingId)) fail('CONFIG', `duplicate mappingId "${m.mappingId}" in registry`);
    if (!byId.has(m.sourceId)) fail('CONFIG', `mapping "${m.mappingId}" references unknown source "${m.sourceId}"`);
    if (m.capabilities.length === 0) fail('CONFIG', `mapping "${m.mappingId}" declares no capabilities`);
    mapById.set(m.mappingId, m);
  }

  const jurisdictionIndex = new Map(jurisdictions.map((j) => [j.jurisdictionId, j] as const));

  const expand = (mapping: SourceJurisdictionMapping): readonly Jurisdiction[] =>
    expandScope(mapping.scope, jurisdictions, `mapping "${mapping.mappingId}"`);

  // Validate every scope eagerly: an unresolvable scope is a configuration bug,
  // not something to discover during a 3am run.
  for (const m of mappings) expand(m);

  const registry: Registry = {
    sources,
    mappings,
    jurisdictions,
    source(sourceId) {
      const s = byId.get(sourceId);
      if (!s) fail('CONFIG', `unknown sourceId "${sourceId}"`);
      return s;
    },
    mapping(mappingId) {
      const m = mapById.get(mappingId);
      if (!m) fail('CONFIG', `unknown mappingId "${mappingId}"`);
      return m;
    },
    mappingsForSource(sourceId) {
      return mappings.filter((m) => m.sourceId === sourceId);
    },
    expand,
    sourcesFor(jurisdictionId, capability) {
      const target = jurisdictionIndex.get(jurisdictionId);
      if (!target) fail('CONFIG', `unknown jurisdictionId "${jurisdictionId}"`);
      const hits = new Set<string>();
      for (const m of mappings) {
        if (!m.capabilities.includes(capability)) continue;
        if (expand(m).some((j) => j.jurisdictionId === jurisdictionId)) hits.add(m.sourceId);
      }
      return [...hits]
        .map((id) => byId.get(id) as SourceDefinition)
        .sort((a, b) => a.sourcePriority - b.sourcePriority || a.sourceId.localeCompare(b.sourceId));
    },
  };

  return registry;
}

export function expandScope(
  scope: JurisdictionScope,
  jurisdictions: readonly Jurisdiction[],
  context: string,
): readonly Jurisdiction[] {
  switch (scope.kind) {
    case 'nation': {
      const nation = jurisdictions.find((j) => j.jurisdictionType === 'nation' && j.country === scope.country);
      if (!nation) fail('CONFIG', `${context}: unknown country "${scope.country}"`);
      return [nation];
    }
    case 'states': {
      return scope.stateCodes.map((code) => {
        const j = getJurisdiction(stateJurisdictionId(code));
        if (!j) fail('CONFIG', `${context}: unknown state code "${code}"`);
        return j;
      });
    }
    case 'all_counties_in_states': {
      const wanted = new Set(scope.stateCodes);
      const counties = jurisdictions.filter((j) => j.jurisdictionType === 'county' && j.stateCode && wanted.has(j.stateCode));
      const covered = new Set(counties.map((c) => c.stateCode));
      for (const code of wanted) {
        if (!covered.has(code)) {
          fail('CONFIG', `${context}: no counties are catalogued for state "${code}"; add them before mapping a county-scoped source`);
        }
      }
      return counties;
    }
    case 'counties': {
      return scope.countyFips.map((fips) => {
        const j = jurisdictions.find((x) => x.countyFips === fips);
        if (!j) fail('CONFIG', `${context}: unknown county FIPS "${fips}"`);
        return j;
      });
    }
  }
}

export { NATION_ID };
