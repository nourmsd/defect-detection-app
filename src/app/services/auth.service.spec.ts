import { describe, it, expect, beforeEach, vi } from 'vitest'
import { AuthService } from './auth.service'
import { HttpClient } from '@angular/common/http'
import { Router } from '@angular/router'

// Minimal mocks for Angular dependencies
const mockHttp = { post: vi.fn(), get: vi.fn() } as unknown as HttpClient
const mockRouter = { navigate: vi.fn() } as unknown as Router

// Mock localStorage
const store: Record<string, string> = {}
const localStorageMock = {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, val: string) => { store[key] = val },
  removeItem: (key: string) => { delete store[key] },
  clear: () => { Object.keys(store).forEach(k => delete store[k]) },
}
Object.defineProperty(window, 'localStorage', { value: localStorageMock, writable: true })

function makeService() {
  return new AuthService(mockHttp, mockRouter)
}

describe('AuthService', () => {

  beforeEach(() => {
    localStorageMock.clear()
    vi.clearAllMocks()
  })

  // TEST 1 — expired token is cleared on session restore
  it('clears token and returns isLoggedIn=false when stored token is expired', () => {
    const expiredPayload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 100 }))
    const fakeToken = `header.${expiredPayload}.sig`
    localStorageMock.setItem('token', fakeToken)

    const service = makeService()

    expect(service.isLoggedIn()).toBe(false)
    expect(localStorageMock.getItem('token')).toBeNull()
  })

  // TEST 2 — handleAuth falls back to firstName + lastName when fullName is absent
  it('builds fullName from firstName and lastName when fullName field is absent', () => {
    const fakeResponse = {
      token: 'fake.jwt.token',
      firstName: 'Nour',
      lastName: 'Messaoudi',
      role: 'worker' as const,
      email: 'nour@test.com',
      id: 'abc123',
    }
    const service = makeService()
    ;(service as any).handleAuth(fakeResponse)

    expect(service.userValue?.fullName).toBe('Nour Messaoudi')
  })

})
