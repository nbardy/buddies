import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { DependencyCard } from '../src/views/dependencies/DependenciesPrompt';

test('dependency cards distinguish installed readiness and give usable setup actions', () => {
  const ready = renderToStaticMarkup(
    <DependencyCard
      check={{ id: 'codex', status: 'ready', message: 'Answered Yes — ready to use.' }}
    />
  );
  assert.match(ready, /✓/);
  assert.match(ready, /Yes — ready/);
  assert.doesNotMatch(ready, /not installed|npm install/);
  const missing = renderToStaticMarkup(
    <DependencyCard
      check={{ id: 'claude', status: 'missing', message: 'Claude is not installed.' }}
    />
  );
  assert.match(missing, /✕/);
  assert.match(missing, /var\(--danger\)/);
  assert.match(missing, /href="https:\/\/code.claude.com\/docs\/en\/quickstart"/);
  assert.match(missing, /value="curl -fsSL https:\/\/claude.ai\/install.sh \| bash"/);
  assert.match(missing, /Copy Install Claude Code command/);
  const login = renderToStaticMarkup(
    <DependencyCard
      check={{
        id: 'claude',
        status: 'failed',
        failure: 'login',
        message: 'Log in from your terminal.',
      }}
    />
  );
  assert.match(login, /Login required/);
  assert.match(login, /value="claude auth login"/);
  const installing = renderToStaticMarkup(
    <DependencyCard
      check={{ id: 'codex', status: 'installing', message: 'Installing automatically…' }}
    />
  );
  assert.match(installing, /Installing automatically/);
  assert.doesNotMatch(installing, /not installed/);
  const quota = renderToStaticMarkup(
    <DependencyCard
      check={{
        id: 'claude',
        status: 'failed',
        failure: 'quota',
        message: 'Installed, but the response check hit an account usage limit.',
      }}
    />
  );
  assert.match(quota, /Installed · usage limit/);
  assert.doesNotMatch(quota, /not installed|value="claude auth login"/);
});
