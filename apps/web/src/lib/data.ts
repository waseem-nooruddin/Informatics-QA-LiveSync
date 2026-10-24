import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { supabase } from './supabase';
import type { DirectoryRow, NavRow, ProjectState, PublicSnapshot } from './types';

const POLL_MS = 30_000;

export function useDirectory() {
  return useQuery({
    queryKey: ['directory'],
    queryFn: async () => {
      const { data, error } = await supabase.from('v_project_directory').select('*').order('name');
      if (error) throw error;
      return data as DirectoryRow[];
    },
    refetchInterval: POLL_MS,
  });
}

export interface NavMainModule {
  id: string;
  name: string;
  submodules: { id: string; name: string }[];
}

/** Validated navigation tree per project (taken only from published snapshots — V1.5 §5.2). */
export function useNavHierarchy() {
  return useQuery({
    queryKey: ['nav-modules'],
    queryFn: async () => {
      const { data, error } = await supabase.from('v_published_hierarchy').select('*');
      if (error) throw error;
      const tree = new Map<string, NavMainModule[]>();
      for (const r of data as NavRow[]) {
        const list = tree.get(r.project_id) ?? [];
        let mm = list.find((m) => m.id === r.main_module_id);
        if (!mm) {
          mm = { id: r.main_module_id, name: r.main_module_name, submodules: [] };
          list.push(mm);
        }
        if (r.submodule_id && r.submodule_name) mm.submodules.push({ id: r.submodule_id, name: r.submodule_name });
        tree.set(r.project_id, list);
      }
      for (const list of tree.values()) {
        list.sort((a, b) => a.name.localeCompare(b.name));
        for (const m of list) m.submodules.sort((a, b) => a.name.localeCompare(b.name));
      }
      return tree;
    },
    refetchInterval: POLL_MS,
  });
}

/** The single source of every KPI, chart and table on a project page (FR-VAL-009). */
export function useSnapshot(projectId: string) {
  return useQuery({
    queryKey: ['snapshot', projectId],
    queryFn: async () => {
      const { data, error } = await supabase.from('v_published_snapshot').select('*').eq('project_id', projectId).maybeSingle();
      if (error) throw error;
      return (data as PublicSnapshot | null) ?? null;
    },
    staleTime: Infinity, // immutable; replaced only when project_state reports a new snapshot id
  });
}

export function useProjectState(projectId: string) {
  return useQuery({
    queryKey: ['state', projectId],
    queryFn: async () => {
      const { data, error } = await supabase.from('project_state').select('*').eq('project_id', projectId).maybeSingle();
      if (error) throw error;
      return (data as ProjectState | null) ?? null;
    },
    refetchInterval: POLL_MS, // fallback polling when realtime is unavailable (FR-SYNC-009)
  });
}

export type LiveStatus = 'connecting' | 'live' | 'polling';

/**
 * Realtime project-scoped status (MP-FR-027). On a new snapshot id the snapshot query is
 * refetched, so every viewer converges on the same snapshot without refreshing (AT-010).
 */
export function useLiveProject(projectId: string): LiveStatus {
  const qc = useQueryClient();
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const state = useProjectState(projectId);
  const snap = useSnapshot(projectId);

  useEffect(() => {
    const ch = supabase
      .channel(`project_state:${projectId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'project_state', filter: `project_id=eq.${projectId}` }, (payload) => {
        qc.setQueryData(['state', projectId], payload.new as ProjectState);
        qc.invalidateQueries({ queryKey: ['directory'] });
      })
      .subscribe((s) => {
        if (s === 'SUBSCRIBED') {
          setStatus('live');
          qc.invalidateQueries({ queryKey: ['state', projectId] }); // catch up after reconnect
        } else if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT' || s === 'CLOSED') setStatus('polling');
      });
    return () => {
      supabase.removeChannel(ch);
    };
  }, [projectId, qc]);

  const liveSnapshotId = state.data?.snapshot_id ?? null;
  const shownSnapshotId = snap.data?.snapshot_id ?? null;
  useEffect(() => {
    if (liveSnapshotId && liveSnapshotId !== shownSnapshotId && !snap.isFetching) {
      qc.invalidateQueries({ queryKey: ['snapshot', projectId] });
      qc.invalidateQueries({ queryKey: ['nav-modules'] });
    }
  }, [liveSnapshotId, shownSnapshotId, snap.isFetching, projectId, qc]);

  return status;
}

/** Ticks every 30 s so freshness/stale labels stay honest without new data. */
export function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
