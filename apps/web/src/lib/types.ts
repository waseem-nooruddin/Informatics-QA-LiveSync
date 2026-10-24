import type { ChartData, HierarchyNode, Kpis, MainModuleId, ModuleRow, RunState, ScopeRules, TableData, TotalRow } from '@qals/core';

export interface PublicModuleRow extends Omit<ModuleRow, 'sources'> {
  sources: { sheetTitle: string }[];
}

export interface PublicTable extends Omit<TableData, 'rows'> {
  rows: PublicModuleRow[];
}

export interface PublicRules extends ScopeRules {
  passRatioDenominator: string;
}

export interface PublicSnapshot {
  project_id: string;
  project_name: string;
  snapshot_id: string;
  version: number;
  published_at: string;
  source_cutoff: string;
  ruleset_version: string;
  ruleset_provisional: boolean;
  mapping_version: string;
  payload: {
    hierarchy: HierarchyNode[];
    table: PublicTable;
    charts: { project: ChartData; byMainModule: Record<MainModuleId, ChartData> };
    kpis: Kpis;
    rules: PublicRules;
  };
  validation: { runState: RunState; gates: GateSummary[]; counts: Record<string, number> };
}

export type { TotalRow };

export interface GateSummary {
  id: string;
  name: string;
  state: 'Passed' | 'Failed' | 'Pending';
  blocking: boolean;
  discrepancyCount: number;
}

export interface ProjectState {
  project_id: string;
  run_id: string | null;
  run_state: RunState;
  gate_progress: GateSummary[];
  source_health: { total: number; healthy: number; failing: number; unchanged?: number };
  last_attempt_at: string | null;
  last_failure_at: string | null;
  last_error: string | null;
  snapshot_id: string | null;
  snapshot_version: number | null;
  last_verified_at: string | null;
  updated_at: string;
}

export interface DirectoryRow {
  project_id: string;
  name: string;
  archived_at: string | null;
  created_at: string;
  snapshot_id: string | null;
  last_verified_at: string | null;
  stale_threshold_minutes: number;
  module_count: number;
  main_module_count: number;
  source_count: number;
  run_state: RunState | null;
  last_attempt_at: string | null;
  last_failure_at: string | null;
}

/** One row of v_published_hierarchy (validated navigation only). */
export interface NavRow {
  project_id: string;
  main_module_id: string;
  main_module_name: string;
  submodule_id: string | null;
  submodule_name: string | null;
}
