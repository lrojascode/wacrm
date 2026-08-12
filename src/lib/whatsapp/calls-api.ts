/**
 * Meta WhatsApp Calling API helpers.
 *
 * Uses Graph API v23.0 for call signaling actions (pre_accept, accept,
 * reject, terminate, and getCallSettings).
 */

import { decrypt } from '@/lib/whatsapp/encryption'
import { supabaseAdmin } from '@/lib/flows/admin-client'

export const META_CALLS_API_VERSION = 'v23.0'
const META_CALLS_API_BASE = `https://graph.facebook.com/${META_CALLS_API_VERSION}`

export interface MetaCallsApiOptions {
  accountId?: string
  phoneNumberId?: string
  accessToken?: string
}

export interface PreAcceptCallOptions extends MetaCallsApiOptions {
  waCallId: string
  userSdp: string
}

export interface AcceptCallOptions extends MetaCallsApiOptions {
  waCallId: string
  userSdp: string
}

export interface RejectCallOptions extends MetaCallsApiOptions {
  waCallId: string
}

export interface TerminateCallOptions extends MetaCallsApiOptions {
  waCallId: string
}

export type GetCallSettingsOptions = MetaCallsApiOptions

export interface CallSettingsResult {
  /** Whether Calling is enabled on the number at all. */
  status: 'ENABLED' | 'DISABLED'
  /**
   * Whether the call button is shown to customers inside WhatsApp.
   * `DISABLE_ALL` hides it, which stops every inbound call at the source
   * — so it has to be surfaced alongside `status` when diagnosing "no
   * one can call us".
   */
  callIconVisibility: 'DEFAULT' | 'DISABLE_ALL' | null
  /** Business-initiated callback permission. This product keeps it off. */
  callbackPermissionStatus: 'ENABLED' | 'DISABLED' | null
}

interface MetaErrorResponse {
  error?: { message?: string; code?: number; type?: string }
}

async function throwMetaError(response: Response, fallback: string): Promise<never> {
  let message = fallback
  try {
    const data = (await response.json()) as MetaErrorResponse
    if (data.error?.message) message = data.error.message
  } catch {
    // response body wasn't JSON — keep fallback
  }
  throw new Error(message)
}

interface ResolvedMetaConfig {
  phoneNumberId: string
  accessToken: string
}

async function resolveCredentials(options: MetaCallsApiOptions): Promise<ResolvedMetaConfig> {
  if (options.phoneNumberId && options.accessToken) {
    return {
      phoneNumberId: options.phoneNumberId,
      accessToken: options.accessToken,
    }
  }

  if (!options.accountId) {
    throw new Error('Either accountId or (phoneNumberId + accessToken) must be provided')
  }

  const { data: config, error } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('phone_number_id, access_token')
    .eq('account_id', options.accountId)
    .single()

  if (error || !config) {
    throw new Error(`WhatsApp not configured for account ${options.accountId}`)
  }

  const accessToken = decrypt(config.access_token)
  return {
    phoneNumberId: config.phone_number_id,
    accessToken,
  }
}

/**
 * Perform a pre_accept handshake for an incoming call offer.
 */
export async function preAcceptCall(options: PreAcceptCallOptions): Promise<{ success: boolean }> {
  const { phoneNumberId, accessToken } = await resolveCredentials(options)
  const url = `${META_CALLS_API_BASE}/${phoneNumberId}/calls`

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      call_id: options.waCallId,
      action: 'pre_accept',
      sdp: options.userSdp,
    }),
  })

  if (!response.ok) {
    await throwMetaError(response, `Failed to pre-accept call ${options.waCallId}`)
  }

  return { success: true }
}

/**
 * Perform an accept action to confirm call connection.
 * Note: userSdp must be byte-identical to the userSdp sent during preAcceptCall.
 */
export async function acceptCall(options: AcceptCallOptions): Promise<{ success: boolean }> {
  const { phoneNumberId, accessToken } = await resolveCredentials(options)
  const url = `${META_CALLS_API_BASE}/${phoneNumberId}/calls`

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      call_id: options.waCallId,
      action: 'accept',
      sdp: options.userSdp,
    }),
  })

  if (!response.ok) {
    await throwMetaError(response, `Failed to accept call ${options.waCallId}`)
  }

  return { success: true }
}

/**
 * Reject an incoming call offer.
 */
export async function rejectCall(options: RejectCallOptions): Promise<{ success: boolean }> {
  const { phoneNumberId, accessToken } = await resolveCredentials(options)
  const url = `${META_CALLS_API_BASE}/${phoneNumberId}/calls`

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      call_id: options.waCallId,
      action: 'reject',
    }),
  })

  if (!response.ok) {
    await throwMetaError(response, `Failed to reject call ${options.waCallId}`)
  }

  return { success: true }
}

/**
 * Terminate an active call session.
 */
export async function terminateCall(options: TerminateCallOptions): Promise<{ success: boolean }> {
  const { phoneNumberId, accessToken } = await resolveCredentials(options)
  const url = `${META_CALLS_API_BASE}/${phoneNumberId}/calls`

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      call_id: options.waCallId,
      action: 'terminate',
    }),
  })

  if (!response.ok) {
    await throwMetaError(response, `Failed to terminate call ${options.waCallId}`)
  }

  return { success: true }
}

/**
 * Query calling capability status for the WhatsApp Business phone number.
 *
 * Reads the `/settings` edge, not `?fields=calling` on the phone-number
 * node: calling configuration lives on the settings edge, and the field
 * projection does not return it. Getting this wrong is silent — the
 * request succeeds and `calling` is simply absent, which this function
 * would have reported as DISABLED on a number where calling was in fact
 * enabled.
 */
export async function getCallSettings(options: GetCallSettingsOptions): Promise<CallSettingsResult> {
  const { phoneNumberId, accessToken } = await resolveCredentials(options)
  const url = `${META_CALLS_API_BASE}/${phoneNumberId}/settings`

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })

  if (!response.ok) {
    await throwMetaError(response, `Failed to fetch call settings for phone number ${phoneNumberId}`)
  }

  const data = (await response.json()) as {
    calling?: {
      status?: 'ENABLED' | 'DISABLED'
      call_icon_visibility?: 'DEFAULT' | 'DISABLE_ALL'
      callback_permission_status?: 'ENABLED' | 'DISABLED'
    }
  }

  return {
    status: data.calling?.status || 'DISABLED',
    callIconVisibility: data.calling?.call_icon_visibility ?? null,
    callbackPermissionStatus: data.calling?.callback_permission_status ?? null,
  }
}
