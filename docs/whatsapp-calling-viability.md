# WhatsApp Business Calling API Viability Analysis (Revised)

## Executive Summary

A comprehensive architecture and policy evaluation was performed on Meta's **WhatsApp Business Calling API** under the project constraint of **no third-party external voice providers** (no Twilio, Agora, Daily.co, or intermediate PBX/SIP servers).

**Revised Conclusion**: Receiving customer-initiated voice calls inside the CRM browser dashboard is **VIABLE without external providers**. However, placing business-initiated calls to customers is **NON-VIABLE as a primary workflow** due to Meta's strict frequency caps and geographic restrictions.

---

## 1. Architecture & Protocol Mechanics

Meta's Cloud API Calling uses **Graph API Webhooks + WebRTC** by default:
- **Signaling**: Call events (`offer`, `ringing`, `accept`, `terminate`) are delivered to the server via Meta Cloud API Webhooks (`calls` webhook field).
- **Media Session**: Browser standard `RTCPeerConnection` establishes a peer-to-peer WebRTC session (ICE / DTLS-SRTP with OPUS codec) against Meta's Cloud Media Servers.

### Pre-existing In-App Infrastructure
wacrm already possesses the core architectural building blocks required:
1. **Server Webhook Receiver**: Created & secured at [`src/app/api/whatsapp/webhook/`](file:///Users/luisr/Proyectos/wacrm/src/app/api/whatsapp/webhook/) to capture Meta `calls` webhook payloads.
2. **Realtime Event Relay**: **Supabase Realtime** channels are already integrated across the inbox to push incoming call offers and SDP signals instantly to the browser client.

---

## 2. Meta Constraints & Rate Limits

| Call Type | Frequency Caps / Rate Limits | Geographic Restrictions | In-CRM Viability |
| :--- | :--- | :--- | :--- |
| **Customer-Initiated** *(Inbound)* | **Unrestricted** (No daily or weekly cap per contact) | **Global** (Available in all supported WhatsApp markets) | **VIABLE** (Agents can answer inbound calls in browser) |
| **Business-Initiated** *(Outbound)* | **Strictly capped**: Max **1 call / day** and **2 calls / week** per business-customer pair | **Restricted**: Unavailable in US, Canada, Egypt, Vietnam, and Nigeria | **NON-VIABLE** (Cannot serve as a general outbound calling tool) |

### Account Eligibility Prerequisites
- **Volume Threshold**: Meta requires the WhatsApp Business Account (WABA) phone number to have a daily messaging limit of at least **2,000 conversations / 24h** to enable Calling in production.

---

## 3. Revised Recommendation & Next Steps

1. **Do NOT build outbound calling**: Business-initiated outbound calling cannot be relied upon due to the 1 call/day & 2 calls/week limit per contact.
2. **Build Inbound Call Reception (Optional Future Milestone)**: Receiving incoming calls initiated by customers is fully viable using existing wacrm Webhook + Supabase Realtime infrastructure without any paid third-party voice providers.

---

## 4. Official Meta Documentation Sources

- **Meta WhatsApp Business Calling Documentation**:  
  https://developers.facebook.com/documentation/business-messaging/whatsapp/calling
- **WhatsApp Cloud API Webhooks (`calls` field)**:  
  https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/components#calls
- **Meta Business Messaging Rate Limits & Policy**:  
  https://developers.facebook.com/docs/whatsapp/cloud-api/support/display-phone-number-status#messaging-limits
