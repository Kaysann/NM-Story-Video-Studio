export type { AudioAnalysis, IllustrationRef, Scene, SyncResolved, TimelineFile } from '../../model/types';
import type { ProjectBundle } from '../../model/project';

/** Sous-ensemble du projet utile à la composition (facilite les tests). */
export type ProjectBundleLike = Pick<ProjectBundle, 'project' | 'assets' | 'lyrics'>;
