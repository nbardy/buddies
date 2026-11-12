import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const [file, authoring] = process.argv.slice(2);
const library = pathToFileURL(authoring).href;
const requireFromLibrary = createRequire(authoring);
registerHooks({
  resolve(specifier, context, next) {
    if (
      context.parentURL === pathToFileURL(file).href &&
      !['expedition', 'zod'].includes(specifier)
    )
      throw new TypeError(
        `An expedition file may import only expedition and zod, got ${specifier}.`
      );
    if (specifier === 'expedition') return { url: library, shortCircuit: true };
    if (specifier === 'zod' || specifier.startsWith('zod/'))
      return [...context.conditions].includes('require') // an array for import, a Set for require
        ? { url: pathToFileURL(requireFromLibrary.resolve(specifier)).href, shortCircuit: true }
        : next(specifier, { ...context, parentURL: library });
    return next(specifier, context);
  },
});
const threw = (message) => process.send({ t: 'error', why: message }, () => process.exit(0));
const START = Symbol.for('expedition.start');
try {
  const mod = await import(pathToFileURL(file).href);
  const plan = [mod.default, mod.default?.default].find((c) => typeof c?.[START] === 'function');
  if (plan) await plan[START]();
  else
    threw(
      'The file must `export default expedition({ contract, agents, steps, plan: async (steps, x) => ... })` from "expedition".'
    );
} catch (error) {
  threw(error instanceof Error ? (error.stack ?? error.message) : String(error));
}
