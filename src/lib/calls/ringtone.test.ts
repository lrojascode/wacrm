import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  startRingtone,
  stopRingtone,
  startTitleFlash,
  stopTitleFlash,
} from './ringtone'

describe('ringtone', () => {
  beforeEach(() => {
    vi.restoreAllMocks()

    const mockDoc = {
      title: 'Original Title',
    }
    Object.defineProperty(global, 'document', {
      value: mockDoc,
      configurable: true,
      writable: true,
    })

    const mockWin = {
      setInterval: vi.fn().mockReturnValue(123),
      clearInterval: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }
    Object.defineProperty(global, 'window', {
      value: mockWin,
      configurable: true,
      writable: true,
    })

    stopRingtone()
    stopTitleFlash()
  })

  it('starts and stops title flash safely', () => {
    document.title = 'Original Title'

    startTitleFlash('📞 Calling...')
    expect(document.title).toBe('Original Title')

    stopTitleFlash()
    expect(document.title).toBe('Original Title')
  })

  it('starts and stops ringtone safely', () => {
    expect(() => {
      startRingtone()
      stopRingtone()
    }).not.toThrow()
  })
})
