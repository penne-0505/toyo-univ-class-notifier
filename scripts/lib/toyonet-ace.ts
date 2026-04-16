import fs from 'node:fs/promises';
import path from 'node:path';
import { repoRoot } from './toyo-enrollment';

export type AssignmentStatus = 'pending' | 'submitted' | 'unknown';

export type Assignment = {
  assignmentId: string;
  courseName: string;
  title: string;
  dueAt: string | null;
  status: AssignmentStatus;
  sourceUrl: string | null;
  notes: string[];
};

export type AssignmentCollectionResult = {
  fetchedAt: string;
  source: 'toyonet-ace';
  available: boolean;
  assignments: Assignment[];
  errors: string[];
};

const assignmentPath = path.join(repoRoot, 'output', 'toyo', 'toyonet-ace-assignments.json');

type AssignmentFileShape = {
  fetchedAt?: string;
  assignments?: Assignment[];
};

function isAssignment(candidate: unknown): candidate is Assignment {
  if (!candidate || typeof candidate !== 'object') {
    return false;
  }
  const value = candidate as Record<string, unknown>;
  return (
    typeof value.assignmentId === 'string' &&
    typeof value.courseName === 'string' &&
    typeof value.title === 'string' &&
    (typeof value.dueAt === 'string' || value.dueAt === null) &&
    (value.status === 'pending' || value.status === 'submitted' || value.status === 'unknown') &&
    (typeof value.sourceUrl === 'string' || value.sourceUrl === null) &&
    Array.isArray(value.notes) &&
    value.notes.every((note) => typeof note === 'string')
  );
}

export async function collectToyoNetAceAssignments(): Promise<AssignmentCollectionResult> {
  try {
    const raw = await fs.readFile(assignmentPath, 'utf8');
    const parsed = JSON.parse(raw) as AssignmentFileShape;
    const assignments = (parsed.assignments ?? []).filter(isAssignment);

    return {
      fetchedAt: parsed.fetchedAt ?? new Date().toISOString(),
      source: 'toyonet-ace',
      available: true,
      assignments,
      errors:
        assignments.length === (parsed.assignments ?? []).length
          ? []
          : [`Ignored malformed assignments in ${assignmentPath}.`],
    };
  } catch (error: unknown) {
    const message =
      error instanceof Error && 'code' in error && error.code === 'ENOENT'
        ? `ToyoNet-ACE collector is not implemented yet. Create ${assignmentPath} or replace collectToyoNetAceAssignments() with a Playwright collector.`
        : error instanceof Error
          ? error.message
          : String(error);

    return {
      fetchedAt: new Date().toISOString(),
      source: 'toyonet-ace',
      available: false,
      assignments: [],
      errors: [message],
    };
  }
}
