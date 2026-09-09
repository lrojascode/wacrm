import { describe, it, expect, vi, beforeEach } from 'vitest'
import { POST as answerPOST } from './[id]/answer/route'
import { POST as connectedPOST } from './[id]/connected/route'
import { POST as hangupPOST } from './[id]/hangup/route'

vi.mock('@/lib/auth/account', () => ({
  requireRole: vi.fn(),
  toErrorResponse: vi.fn((err: unknown) => {
    const errorObj = err as { message?: string; status?: number }
    return new Response(JSON.stringify({ error: errorObj.message || 'Error' }), {
      status: errorObj.status || 500,
    })
  }),
}))

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: vi.fn(),
}))

vi.mock('@/lib/whatsapp/calls-api', () => ({
  preAcceptCall: vi.fn().mockResolvedValue({ success: true }),
  acceptCall: vi.fn().mockResolvedValue({ success: true }),
  rejectCall: vi.fn().mockResolvedValue({ success: true }),
  terminateCall: vi.fn().mockResolvedValue({ success: true }),
}))

import { requireRole } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { preAcceptCall, acceptCall, rejectCall, terminateCall } from '@/lib/whatsapp/calls-api'

describe('Call Control Routes', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.mocked(requireRole).mockResolvedValue({
      userId: 'usr_agent1',
      accountId: 'acc_100',
    } as unknown as Awaited<ReturnType<typeof requireRole>>)
  })

  describe('POST /api/calls/[id]/answer', () => {
    it('claims ringing call and invokes preAcceptCall when authorized', async () => {
      const mockFrom = vi.fn().mockImplementation((table: string) => {
        if (table === 'call_sessions') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: {
                      id: 'cs_10',
                      account_id: 'acc_100',
                      ring_user_ids: ['usr_agent1'],
                      status: 'ringing',
                    },
                    error: null,
                  }),
                }),
              }),
            }),
            update: () => ({
              eq: () => ({
                eq: () => ({
                  eq: () => ({
                    is: () => ({
                      select: async () => ({
                        data: [
                          {
                            id: 'cs_10',
                            account_id: 'acc_100',
                            wa_call_id: 'wacid_10',
                            offer_sdp: 'v=0...',
                          },
                        ],
                        error: null,
                      }),
                    }),
                  }),
                }),
              }),
            }),
          }
        }
        return {}
      })

      vi.mocked(supabaseAdmin).mockReturnValue({
        from: mockFrom as unknown as ReturnType<typeof supabaseAdmin>['from'],
      } as unknown as ReturnType<typeof supabaseAdmin>)

      const req = new Request('http://localhost/api/calls/cs_10/answer', {
        method: 'POST',
        body: JSON.stringify({ userSdp: 'v=0...' }),
      })

      const res = await answerPOST(req, { params: Promise.resolve({ id: 'cs_10' }) })
      expect(res.status).toBe(200)

      const json = await res.json()
      expect(json.success).toBe(true)
      expect(preAcceptCall).toHaveBeenCalledWith({
        accountId: 'acc_100',
        waCallId: 'wacid_10',
        userSdp: 'v=0...',
      })
    })

    it('returns 403 when user is not in ring_user_ids', async () => {
      const mockFrom = vi.fn().mockImplementation((table: string) => {
        if (table === 'call_sessions') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: {
                      id: 'cs_10',
                      account_id: 'acc_100',
                      ring_user_ids: ['usr_agent2'],
                      status: 'ringing',
                    },
                    error: null,
                  }),
                }),
              }),
            }),
          }
        }
        return {}
      })

      vi.mocked(supabaseAdmin).mockReturnValue({
        from: mockFrom as unknown as ReturnType<typeof supabaseAdmin>['from'],
      } as unknown as ReturnType<typeof supabaseAdmin>)

      const req = new Request('http://localhost/api/calls/cs_10/answer', {
        method: 'POST',
        body: JSON.stringify({ userSdp: 'v=0...' }),
      })

      const res = await answerPOST(req, { params: Promise.resolve({ id: 'cs_10' }) })
      expect(res.status).toBe(403)

      const json = await res.json()
      expect(json.error).toContain('not authorized')
    })
  })

  describe('POST /api/calls/[id]/connected', () => {
    it('accepts call with saved answer_sdp', async () => {
      const mockFrom = vi.fn().mockImplementation((table: string) => {
        if (table === 'call_sessions') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: {
                      id: 'cs_10',
                      account_id: 'acc_100',
                      wa_call_id: 'wacid_10',
                      answered_by: 'usr_agent1',
                      answer_sdp: 'v=0...saved_sdp',
                    },
                    error: null,
                  }),
                }),
              }),
            }),
            update: () => ({
              eq: () => ({
                eq: async () => ({ data: null, error: null }),
              }),
            }),
          }
        }
        return {}
      })

      vi.mocked(supabaseAdmin).mockReturnValue({
        from: mockFrom as unknown as ReturnType<typeof supabaseAdmin>['from'],
      } as unknown as ReturnType<typeof supabaseAdmin>)

      const req = new Request('http://localhost/api/calls/cs_10/connected', {
        method: 'POST',
      })

      const res = await connectedPOST(req, { params: Promise.resolve({ id: 'cs_10' }) })
      expect(res.status).toBe(200)

      expect(acceptCall).toHaveBeenCalledWith({
        accountId: 'acc_100',
        waCallId: 'wacid_10',
        userSdp: 'v=0...saved_sdp',
      })
    })
  })

  describe('POST /api/calls/[id]/hangup', () => {
    it('rejects ringing call when hangup requested', async () => {
      const mockFrom = vi.fn().mockReturnValue({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  id: 'cs_10',
                  account_id: 'acc_100',
                  wa_call_id: 'wacid_10',
                  status: 'ringing',
                },
                error: null,
              }),
            }),
          }),
        }),
        update: () => ({
          eq: () => ({
            eq: async () => ({ data: null, error: null }),
          }),
        }),
      })

      vi.mocked(supabaseAdmin).mockReturnValue({
        from: mockFrom as unknown as ReturnType<typeof supabaseAdmin>['from'],
      } as unknown as ReturnType<typeof supabaseAdmin>)

      const req = new Request('http://localhost/api/calls/cs_10/hangup', {
        method: 'POST',
      })

      const res = await hangupPOST(req, { params: Promise.resolve({ id: 'cs_10' }) })
      expect(res.status).toBe(200)

      expect(rejectCall).toHaveBeenCalledWith({
        accountId: 'acc_100',
        waCallId: 'wacid_10',
      })
    })
  })
})
