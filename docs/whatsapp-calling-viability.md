# WhatsApp Business Calling API Viability Analysis

## Executive Summary

An evaluation was performed on Meta's WhatsApp Business Calling API (Cloud API Voice) under the project constraint of **no third-party external providers** (no Twilio, Agora, Daily.co, or intermediate SIP/PBX infrastructure).

**Conclusion**: Directly establishing production Browser ↔ Meta WebRTC voice calls strictly inside a pure client browser context without an intermediate media/signaling server or SIP gateway is **NON-VIABLE**.

---

## Technical Findings

### 1. Protocol & Signaling Requirements
- Meta Cloud API Calling uses **Graph API Webhooks** for call signaling (`calls` webhook field for `offer`, `ringing`, `accept`, `terminate`).
- Web browsers cannot receive HTTP webhooks directly; server-side webhook endpoints paired with server-to-browser WebSockets/SSE are strictly required to relay SDP offers/answers.

### 2. Media Infrastructure & NAT Traversal
- Meta's voice servers expect standard SDP offer/answer exchanges over DTLS-SRTP using the OPUS codec.
- Direct browser `RTCPeerConnection` to Meta media endpoints fails across symmetric NATs without custom STUN/TURN media relay infrastructure.

### 3. Business Account & Setup Requirements
- Meta requires a minimum daily messaging limit of **2,000 conversations / 24h** per WABA number to enable Calling in production.
- Meta's official recommended architecture for agent seat calling requires a compliant **SIP User Agent / PBX** (e.g., PJSIP, Asterisk, FreeSWITCH) with TLS transport.

---

## Recommendation

Do not attempt a fragile browser-only WebRTC hack without media relay servers. When voice call support is required in the future, provision a dedicated self-hosted SIP/WebRTC gateway (e.g., FreeSWITCH/Janus) adhering to Meta's Cloud API Calling specifications.
