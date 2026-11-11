// The plan process's entry (runner.ts spawns it under tsx). argv: <plan file> <authoring entry>.
// Plain ESM so it needs no transform of its own.
//
// A plan lives anywhere on disk and imports two bare specifiers: `expedition` (the authoring
// library) and `zod`. Synchronous module hooks (module.registerHooks) apply to both `import` and
// `require`, so they hold whichever module format tsx loads the plan as: `expedition` resolves to
// the library file, and `zod` resolves as if the library had imported it, i.e. from server's
// node_modules, the same package the library validates with. For `require`, Node's default
// resolver ignores `context.parentURL`, so that case resolves from the library explicitly.
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

// Before the session opens, a failure is reported here directly.
const threw = (message) => process.send({ t: 'threw', message }, () => process.exit(0));
const START = Symbol.for('expedition.start');

try {
  const mod = await import(pathToFileURL(file).href);
  // An ESM plan's default export is the Plan; a plan tsx compiled to CommonJS arrives wrapped once.
  const plan = [mod.default, mod.default?.default].find((c) => typeof c?.[START] === 'function');
  if (plan) plan[START]();
  else
    threw(
      'The file must `export default expedition({ contract, agents, steps, plan: async (steps, x) => ... })` from "expedition".'
    );
} catch (error) {
  threw(error instanceof Error ? (error.stack ?? error.message) : String(error));
}
