const jwt = require('jsonwebtoken')

// The function you are testing (extract it from your route file)
function generateToken(user) {
  return jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET || 'testsecret', { expiresIn: '8h' })
}

function verifyToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET || 'testsecret')
}

describe('Auth — token lifecycle', () => {

  // TEST 1 — valid token decodes correctly
  it('generated token contains correct role', () => {
    const fakeUser = { _id: '123', role: 'worker' }
    const token = generateToken(fakeUser)
    const decoded = verifyToken(token)
    expect(decoded.role).toBe('worker')
  })

  // TEST 2 — expired token throws
  it('throws when token is expired', () => {
    const expiredToken = jwt.sign({ id: '123' }, 'testsecret', { expiresIn: '0s' })
    expect(() => verifyToken(expiredToken)).toThrow()
  })

})