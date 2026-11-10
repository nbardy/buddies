import Ajv, { type ValidateFunction } from 'ajv';

// A call's `output` is a JSON Schema (the authoring library makes it with zod-to-json-schema). The
// executor checks an answer against it BEFORE reporting `ok`: the plan process re-validates with
// zod, but only after the kernel has logged `passed` or started a paid judge on it (CONNECT_PLAN
// §0.3). Formats (`email`, `uuid`, ...) are not checked here; zod checks them in the plan, and the
// shape is what must hold before anything is logged or judged.

const ajv = new Ajv({
  allErrors: true,
  // Unknown keywords still fail to compile; ajv's opinions on type unions do not.
  strictTypes: false,
  strictTuples: false,
  validateFormats: false,
});
const compiled = new Map<string, ValidateFunction>();

export type Checked = { readonly t: 'valid' } | { readonly t: 'invalid'; readonly why: string };

export function checkOutput(schema: unknown, value: unknown): Checked {
  const key = JSON.stringify(schema);
  let validate = compiled.get(key);
  if (!validate) {
    try {
      validate = ajv.compile(schema as object);
    } catch (e) {
      return { t: 'invalid', why: `the output schema does not compile: ${(e as Error).message}` };
    }
    compiled.set(key, validate);
  }
  if (validate(value)) return { t: 'valid' };
  return { t: 'invalid', why: ajv.errorsText(validate.errors, { dataVar: 'output' }) };
}
