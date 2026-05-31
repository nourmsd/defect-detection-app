const jwt = require('jsonwebtoken');
const authMiddleware = require('../middleware/auth');
const roleMiddleware = require('../middleware/role');

const SECRET = 'your_jwt_secret';

// Helper: build a fake Express req/res/next
function makeReqRes(headers = {}, user = null) {
  const req = { headers, user };
  const res = {
    _status: null,
    _body: null,
    status(code) { this._status = code; return this; },
    json(body)   { this._body = body;   return this; },
  };
  const next = jest.fn();
  return { req, res, next };
}

// ─── authMiddleware ────────────────────────────────────────────────

describe('authMiddleware', () => {

  // TEST 1 — valid token → calls next() and attaches decoded user to req
  it('accepts a valid token and calls next()', () => {
    const token = jwt.sign({ id: 'u1', role: 'worker' }, SECRET, { expiresIn: '1h' });
    const { req, res, next } = makeReqRes({ authorization: `Bearer ${token}` });

    authMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);   // request continues
    expect(req.user.role).toBe('worker');     // user attached
  });

  // TEST 2 — missing token → 401, next() never called
  it('rejects request with no Authorization header with 401', () => {
    const { req, res, next } = makeReqRes({});

    authMiddleware(req, res, next);

    expect(res._status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

});

// ─── roleMiddleware ────────────────────────────────────────────────

describe('roleMiddleware', () => {

  // TEST 1 — legacy 'admin' role is treated as 'supervisor' and allowed
  it('maps legacy admin role to supervisor and grants access', () => {
    const { req, res, next } = makeReqRes({}, { role: 'admin' });

    roleMiddleware(['supervisor'])(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);   // allowed through
    expect(res._status).toBeNull();          // no error response
  });

  // TEST 2 — unauthorized role → 403, next() never called
  it('blocks a worker from a supervisor-only route with 403', () => {
    const { req, res, next } = makeReqRes({}, { role: 'worker' });

    roleMiddleware(['supervisor'])(req, res, next);

    expect(res._status).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

});
