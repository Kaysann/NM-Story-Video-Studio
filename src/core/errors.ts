// Erreurs typées : chaque erreur porte un code stable, un message français et une action proposée.

export type ErrorCode =
  | 'E_SCHEMA'
  | 'E_PROJECT_NOT_FOUND'
  | 'E_PROJECT_EXISTS'
  | 'E_ASSET_MISSING'
  | 'E_ASSET_LOWRES'
  | 'E_DEP_MISSING'
  | 'E_PY_FAILED'
  | 'E_RENDER_FAILED'
  | 'E_FFMPEG'
  | 'E_QC_BLOCKING'
  | 'E_LOCKED_FILE'
  | 'E_TIMELINE_GAP'
  | 'E_ANCHOR'
  | 'E_SYNC_MISSING'
  | 'E_REELS'
  | 'E_EXPORT_EXISTS'
  | 'E_PROFILE'
  | 'E_CLEAN_REFUSED'
  | 'E_ARGS'
  | 'E_INTERRUPTED'
  | 'E_INTERNAL';

export const EXIT_CODES: Partial<Record<ErrorCode, number>> = {
  E_ARGS: 2,
  E_SCHEMA: 2,
  E_DEP_MISSING: 3,
  E_QC_BLOCKING: 5,
  E_INTERRUPTED: 130,
};

export class NmsvsError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly action?: string,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'NmsvsError';
  }

  toJSON() {
    return { code: this.code, message: this.message, action: this.action, detail: this.detail };
  }
}

export function asNmsvsError(e: unknown): NmsvsError {
  if (e instanceof NmsvsError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  return new NmsvsError('E_INTERNAL', msg, 'Consulter le journal (log.jsonl) de l’exécution.', e instanceof Error ? e.stack : undefined);
}
