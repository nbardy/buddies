import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import {
  type AuthDecision,
  LOGIN_PATH,
  LOGOUT_PATH,
  PAIR_PATH,
  buildClearedSessionCookie,
  buildSessionCookie,
  decideAuth,
  isSecureRequest,
  safeRedirectTarget,
  tokenMatches,
} from './gate';
import { type LoginNotice, loginNoticeFromQuery, loginPageHtml } from './login-page';
import type { PairingCodes } from './pairing';
import type { AuthPolicy } from './policy';
import type { TailnetOwnerWatch } from './tailnet-owner';

/**
 * Express adapter over `decideAuth`. Mount this before every route — the app
 * shell, the API, and uploads are all behind it, so an unauthenticated caller
 * cannot even discover which endpoints exist.
 */

function gateRequest(request: Request) {
  return {
    method: request.method,
    url: request.originalUrl,
    headers: request.headers,
    peer: request.socket.remoteAddress ?? '',
  };
}

export interface AuthRouteDeps {
  readonly owner: TailnetOwnerWatch;
  readonly pairing: PairingCodes;
}

function renderLogin(
  response: Response,
  status: number,
  notice: LoginNotice,
  redirectTo: string
): void {
  response.status(status).type('html').send(loginPageHtml({ notice, redirectTo }));
}

/**
 * The enhanced login form asks for JSON so it can tell "wrong key" apart from
 * "server unreachable"; a plain form POST (no JS) still gets HTML and a 302.
 */
function wantsJson(request: Request): boolean {
  return request.accepts(['html', 'json']) === 'json';
}

function sendChallenge(request: Request, response: Response, wants: 'html' | 'json'): void {
  if (wants === 'json') {
    response.status(401).json({ error: 'unauthorized', message: 'Missing or invalid access key' });
    return;
  }
  renderLogin(response, 401, { kind: 'none' }, request.originalUrl);
}

function applyDecision(
  decision: AuthDecision,
  request: Request,
  response: Response,
  next: NextFunction
): void {
  if (decision.kind === 'allow') {
    next();
    return;
  }
  if (decision.kind === 'establish') {
    response.setHeader(
      'Set-Cookie',
      buildSessionCookie(decision.token, { secure: isSecureRequest(gateRequest(request)) })
    );
    response.redirect(302, decision.location);
    return;
  }
  sendChallenge(request, response, decision.wants);
}

export function registerAuthRoutes(app: Express, policy: AuthPolicy, deps: AuthRouteDeps): void {
  // Login and logout must stay reachable without a credential, so they are
  // registered ahead of the gate rather than exempted from inside it.

  // GET is what the client redirects to on a 401, so a session that expires
  // mid-use lands on a real page instead of a blank or half-broken shell.
  app.get(LOGIN_PATH, (request: Request, response: Response) => {
    const redirectTo = safeRedirectTarget(request.query.redirectTo);
    // Already admitted (open, this machine's browser, the owner's tailnet
    // device, a valid cookie): a login form would only ask for a key nobody needs.
    if (decideAuth(policy, gateRequest(request), deps.owner.current()).kind === 'allow') {
      response.redirect(302, redirectTo);
      return;
    }
    const notice = loginNoticeFromQuery(
      typeof request.query.error === 'string' ? request.query.error : undefined
    );
    renderLogin(response, 200, notice, redirectTo);
  });

  app.post(
    LOGIN_PATH,
    express.urlencoded({ extended: false, limit: '4kb' }),
    (request: Request, response: Response) => {
      const redirectTo = safeRedirectTarget(request.body?.redirectTo);
      if (policy.kind === 'open') {
        if (wantsJson(request)) {
          response.status(200).json({ ok: true, redirectTo });
          return;
        }
        response.redirect(302, redirectTo);
        return;
      }

      const submitted = typeof request.body?.token === 'string' ? request.body.token.trim() : '';
      if (!submitted || !tokenMatches(submitted, policy.digest)) {
        if (wantsJson(request)) {
          response.status(401).json({ ok: false, error: 'invalid_key' });
          return;
        }
        renderLogin(response, 401, { kind: 'invalid-key' }, redirectTo);
        return;
      }

      response.setHeader(
        'Set-Cookie',
        buildSessionCookie(submitted, { secure: isSecureRequest(gateRequest(request)) })
      );
      if (wantsJson(request)) {
        response.status(200).json({ ok: true, redirectTo });
        return;
      }
      response.redirect(302, redirectTo);
    }
  );

  // The Connect-mobile QR lands here. The code is exchanged for the same
  // year-long cookie the login form sets; the key never appears in the URL.
  app.get(PAIR_PATH, (request: Request, response: Response) => {
    const code = typeof request.query.code === 'string' ? request.query.code : '';
    if (policy.kind === 'open') {
      response.redirect(302, '/');
      return;
    }
    if (!code || !deps.pairing.redeem(code)) {
      response.redirect(302, `${LOGIN_PATH}?error=pairing-expired`);
      return;
    }
    response.setHeader(
      'Set-Cookie',
      buildSessionCookie(policy.token, { secure: isSecureRequest(gateRequest(request)) })
    );
    response.redirect(302, '/');
  });

  app.get(LOGOUT_PATH, (_request: Request, response: Response) => {
    response.setHeader('Set-Cookie', buildClearedSessionCookie());
    response.redirect(302, `${LOGIN_PATH}?error=signed-out`);
  });

  app.use((request: Request, response: Response, next: NextFunction) => {
    applyDecision(
      decideAuth(policy, gateRequest(request), deps.owner.current()),
      request,
      response,
      next
    );
  });
}
