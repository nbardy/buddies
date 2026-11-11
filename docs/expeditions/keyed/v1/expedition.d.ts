/**
 * Expeditions v1: the authoring API (docs/expeditions/keyed/v1/DESIGN.md).
 *
 * This file is only a pointer: the API is the library itself,
 * server/src/expedition-kernel/authoring/index.ts, which plans import as `expedition` and which the
 * host's typecheck gate checks every plan against. Until 2026-11-10 this was a hand-kept copy of the
 * declarations; a copy can drift from the library the gate and the runner actually use, so it now
 * re-exports the source. Plans import it as `expedition`; only expedition and the optional item-inference step wrapper are runtime exports.
 */
/// <reference path="../../../../server/node_modules/@types/node/index.d.ts" />
export * from '../../../../server/src/expedition-kernel/authoring/index';
