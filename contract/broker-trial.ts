/** Isolated connection-broker experiment; not part of the controller's public API. */
export interface TrialLinkReply { redirectUrl: string }
export interface TrialDisconnectReply { status: 'not-connected' }
export interface TrialStatusReply { status: 'not-connected' | 'pending' | 'connected' | 'unverified' | 'needs-auth' }
export interface TrialProfileReply { id: string; name: string; email: string }
/** Identity returned by a narrow profile check where a provider may not expose email. */
export interface TrialIdentityProfileReply { id: string; label: string }
/** Gmail mailbox metadata only; this reply contains no message contents. */
export interface TrialGmailProfileReply { emailAddress: string; messagesTotal: number; threadsTotal: number; historyId: string }
