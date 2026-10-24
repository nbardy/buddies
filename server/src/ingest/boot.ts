/**
 * Boot of the ingest store (crates/unleashd-ingest) and the conversation list read from it.
 *
 * The store keeps its own cache file (`ingest.sqlite` under the app data dir): a warm start
 * re-reads only changed transcripts (~2 s on 7,968 sources), a cold one ~26 s. `onChange` fires
 * during the initial scan too; it is forwarded to the list once the list exists, and the list's
 * first `listSessions` covers everything committed before that.
 */

import path from 'node:path';
import { type ChangeEvent, Ingest, defaultRoots } from '@unleashd/ingest';
import { timeBootPhaseAsync } from '../observability/perf';
import {
  type ConversationList,
  type ConversationListDependencies,
  createConversationList,
} from './conversation-list';
import { provideIngest } from './instance';

export interface BootedIngest {
  ingest: Ingest;
  list: ConversationList;
}

export async function bootIngest(
  options: { home: string; appDataDir: string },
  dependencies: Omit<ConversationListDependencies, 'ingest'>
): Promise<BootedIngest> {
  let forward: (event: ChangeEvent) => void = () => undefined;
  // Sub-phases of boot.jsonl's `ingest_start`: store open + source scan (Rust), then the list build.
  const ingest = await timeBootPhaseAsync('ingest_scan', () =>
    Ingest.start(
      defaultRoots(options.home),
      path.join(options.appDataDir, 'ingest.sqlite'),
      (event) => forward(event)
    )
  );
  const scan = ingest.initialScan;
  const logger = dependencies.logger ?? console;
  logger.log(
    `[ingest] ${scan.sources} sources (${scan.full} read in full, ${scan.unchanged} unchanged) in ${scan.ms} ms`
  );
  for (const error of scan.errors) logger.warn(`[ingest] ${error}`);
  provideIngest(ingest);
  const list = await timeBootPhaseAsync('ingest_list_build', () =>
    createConversationList({ ...dependencies, ingest })
  );
  forward = list.onChange;
  return { ingest, list };
}
