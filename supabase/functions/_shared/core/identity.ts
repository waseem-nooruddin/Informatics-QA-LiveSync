import type { DefectRecord, Lineage, TestRecord } from './types.ts';

// Deduplication keys always include project scope (MP-FR-021, FR-DEDUP-001/003).
export const testKey = (t: Pick<TestRecord, 'projectId' | 'mainModuleId' | 'moduleId' | 'testCaseId'>): string =>
  `${t.projectId}|${t.mainModuleId}|${t.moduleId}|${t.testCaseId}`;

/** Main-module-level identity used to detect one test case attributed to two submodules (calc-v1 rule 6). */
export const testMainKey = (t: Pick<TestRecord, 'projectId' | 'mainModuleId' | 'testCaseId'>): string =>
  `${t.projectId}|${t.mainModuleId}|${t.testCaseId}`;

export const defectKey = (d: Pick<DefectRecord, 'projectId' | 'defectId'>): string => `${d.projectId}|${d.defectId}`;

export const lineageRef = (l: Lineage): string => `${l.fileId}:${l.sheetId}:R${l.row}`;
