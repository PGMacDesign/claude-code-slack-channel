/**
 * button-actions.ts — session-posted buttons and their clicks.
 *
 * `send_actions` lets the session post a message with up to five buttons; a
 * click on one comes back into the session as a channel notification, the same
 * way an inbound message does. A button with a `prompt` opens a reply box
 * instead, and the typed text comes back with the click. Kept out of server.ts
 * so the handlers can be unit-tested against fakes without the server's
 * module-load side effects.
 *
 * Button action ids are `act:<n>`, or `act:<n>:m` for a reply-box button,
 * disjoint from the bridge's own `perm:` permission buttons, so neither path
 * can resolve the other's clicks.
 */

import { z } from 'zod'

export const ACT_PREFIX = 'act:'
// Marks a button whose value is a `{v, p}` envelope carrying the reply-box
// prompt. The prompt rides in the posted message itself, so a click needs
// nothing from the bridge's memory to open the box, even after a restart.
const PROMPT_SUFFIX = ':m'
export const MAX_BUTTONS = 5
// Slack limits: section text 3000 chars, button text 75, button value 2000.
export const MAX_ACTION_TEXT = 2900
export const MAX_BUTTON_LABEL = 75
export const MAX_BUTTON_VALUE = 2000
export const MAX_BUTTON_PROMPT = 150
// Slack limits: view private_metadata 3000 chars, plain_text_input 3000.
export const MAX_VIEW_METADATA = 3000
export const MAX_REPLY_TEXT = 3000
export const REPLY_VIEW_CALLBACK = 'act_reply'
const REPLY_BLOCK = 'reply'
const REPLY_INPUT = 'text'
// Bounds the in-memory dedupe set; a click older than this many forwards is
// long settled, and its button was removed from the message anyway.
export const FORWARDED_CAP = 5000
// Bounds the snapshots kept for open reply boxes. Losing one only skips the
// cosmetic message update; the reply itself still goes through.
export const REPLY_CACHE_CAP = 200

export type ButtonStyle = 'primary' | 'danger'

export interface ActionButton {
  label: string
  value: string
  style?: ButtonStyle
  prompt?: string
}

/** The value Slack stores on the button: the raw value, or for a reply-box
 *  button the `{v, p}` envelope that also carries the prompt. */
export function encodeButtonValue(b: ActionButton): string {
  return b.prompt === undefined ? b.value : JSON.stringify({ v: b.value, p: b.prompt })
}

/** Input schema for the `send_actions` tool. Lives here, not in server.ts, so
 *  it can be tested without the server's bootstrap. */
export const SendActionsInput = z
  .object({
    chat_id: z.string().min(1),
    text: z.string().min(1).max(MAX_ACTION_TEXT),
    thread_ts: z.string().optional(),
    buttons: z
      .array(
        z
          .object({
            label: z.string().min(1).max(MAX_BUTTON_LABEL),
            value: z.string().min(1).max(MAX_BUTTON_VALUE),
            style: z.enum(['primary', 'danger']).optional(),
            prompt: z.string().min(1).max(MAX_BUTTON_PROMPT).optional(),
          })
          .strict()
          .refine((b) => encodeButtonValue(b).length <= MAX_BUTTON_VALUE, {
            message: `value and prompt together must fit in ${MAX_BUTTON_VALUE} characters`,
          }),
      )
      .min(1)
      .max(MAX_BUTTONS),
  })
  .strict()

/** Everything `send_actions` posts to Slack, for the outbound secret guard:
 *  the text, and every label, value and prompt. */
export function sendActionsOutboundText(args: { text: string; buttons: readonly ActionButton[] }): string {
  return [args.text, ...args.buttons.flatMap((b) => [b.label, b.value, b.prompt ?? ''])].join('\n')
}

// biome-ignore lint/suspicious/noExplicitAny: Slack Block Kit blocks are open-ended JSON
type Block = { type: string; [key: string]: any }

export function isActAction(actionId: string): boolean {
  return actionId.startsWith(ACT_PREFIX)
}

function isPromptAction(actionId: string): boolean {
  return isActAction(actionId) && actionId.endsWith(PROMPT_SUFFIX)
}

/** The button's value and, for a reply-box button, its prompt. Null when a
 *  reply-box button's envelope is unreadable, which only a message the bridge
 *  did not build could carry. */
function decodeButtonValue(actionId: string, raw: string): { value: string; prompt?: string } | null {
  if (!isPromptAction(actionId)) return { value: raw }
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed?.v === 'string' && typeof parsed?.p === 'string') return { value: parsed.v, prompt: parsed.p }
  } catch {
    /* fall through */
  }
  return null
}

export function buildActionMessageBlocks(text: string, buttons: readonly ActionButton[]): Block[] {
  return [
    { type: 'section', text: { type: 'mrkdwn', text } },
    {
      type: 'actions',
      elements: buttons.map((b, i) => ({
        type: 'button',
        action_id: `${ACT_PREFIX}${i}${b.prompt === undefined ? '' : PROMPT_SUFFIX}`,
        text: { type: 'plain_text', text: b.label, emoji: true },
        value: encodeButtonValue(b),
        ...(b.style ? { style: b.style } : {}),
      })),
    },
  ]
}

/** The clicked message's blocks minus every spent button, plus a line naming
 *  the choice. Every other button keeps its label, value and style; an actions
 *  block left empty is dropped. `isSpent` comes from the dedupe set rather than
 *  just the clicked id because a click payload carries the message as it was
 *  before earlier clicks' updates landed; rebuilding from that snapshot alone
 *  would bring an already-used button back. */
export function withoutSpentButtons(
  blocks: readonly Block[],
  isSpent: (actionId: string) => boolean,
  choiceLine: string,
): Block[] {
  const kept: Block[] = []
  for (const block of blocks) {
    if (block.type !== 'actions') {
      kept.push(block)
      continue
    }
    const elements = (block.elements ?? []).filter((e: Block) => !isSpent(e.action_id))
    if (elements.length > 0) kept.push({ ...block, elements })
  }
  kept.push({ type: 'context', elements: [{ type: 'plain_text', text: choiceLine, emoji: true }] })
  return kept
}

/** The message a reply box was opened from, as the click saw it. */
export interface CachedMessage {
  text: string
  blocks: Block[]
}

export interface ActClickDeps {
  allowFrom: () => readonly string[]
  forwarded: Set<string>
  resolveUserName: (userId: string) => Promise<string>
  /** Bookkeeping the server does for any input that reaches the session: the
   *  outbound gate's delivered-threads set, the permission relay's last active
   *  thread, the audit journal. Called just before notify. */
  recordInbound: (args: {
    channel: string
    threadTs: string | undefined
    userId: string
    messageTs: string
    reason: string
  }) => void
  notify: (params: { content: string; meta: Record<string, string> }) => Promise<void> | void
  update: (args: { channel: string; ts: string; text: string; blocks: Block[] }) => Promise<unknown>
  postEphemeral: (args: { channel: string; user: string; text: string }) => Promise<unknown>
  openView: (args: { trigger_id: string; view: Block }) => Promise<unknown>
  /** Snapshots of messages with an open reply box, keyed like `forwarded`. */
  replyCache: Map<string, CachedMessage>
}

export type ActClickOutcome = 'ignored' | 'refused' | 'duplicate' | 'forwarded' | 'opened' | 'failed'

const SLACK_ID = /^[A-Z0-9]{1,32}$/

/** Which button on which message, plus what the session is told about it. */
export interface ButtonRoute {
  channel: string
  messageTs: string
  actionId: string
  label: string
  value: string
  // Only a message that really sits in a thread reports one, exactly like an
  // inbound message; inventing one from the message ts would point the session
  // at a thread the outbound gate never saw.
  threadTs: string | undefined
}

const keyOf = (channel: string, messageTs: string, actionId: string) => `${channel}:${messageTs}:${actionId}`
const routeKey = (r: ButtonRoute) => keyOf(r.channel, r.messageTs, r.actionId)
const spentOn = (deps: ActClickDeps, r: ButtonRoute) => (id: string) =>
  deps.forwarded.has(keyOf(r.channel, r.messageTs, id))

/** Mark a button used. Synchronous, and every caller runs it before its first
 *  await after the spent check, so a concurrent duplicate sees it. */
function spend(forwarded: Set<string>, key: string): void {
  forwarded.add(key)
  for (const oldest of forwarded) {
    if (forwarded.size <= FORWARDED_CAP) break
    forwarded.delete(oldest)
  }
}

async function tellUser(deps: ActClickDeps, channel: string, user: string, text: string): Promise<void> {
  try {
    await deps.postEphemeral({ channel, user, text })
  } catch {
    /* non-critical */
  }
}

/** Handle one `block_actions` payload for an `act:` button. The caller has
 *  already acknowledged the interaction. Order matters:
 *  owner check, then the synchronous dedupe write (before any await, so a
 *  concurrent duplicate sees it), then notify, then the message update, which
 *  is best-effort so a Slack error can never swallow the click. A reply-box
 *  button opens its box instead and is spent only when the reply is sent. */
// biome-ignore lint/suspicious/noExplicitAny: interaction payloads are untyped JSON from Slack
export async function handleActClick(deps: ActClickDeps, body: any): Promise<ActClickOutcome> {
  const action = body?.actions?.[0]
  const actionId: string = action?.action_id ?? ''
  const channel: string = body?.channel?.id ?? ''
  const messageTs: string = body?.message?.ts ?? ''
  const userId: string = body?.user?.id ?? ''
  const decoded = decodeButtonValue(actionId, String(action?.value ?? ''))
  if (!isActAction(actionId) || !channel || !messageTs || !SLACK_ID.test(userId) || !decoded) return 'ignored'

  if (!deps.allowFrom().includes(userId)) {
    await tellUser(deps, channel, userId, 'Only the session owner can use these buttons.')
    return 'refused'
  }

  const route: ButtonRoute = {
    channel,
    messageTs,
    actionId,
    label: String(action?.text?.text ?? actionId).slice(0, MAX_BUTTON_LABEL),
    value: decoded.value.slice(0, MAX_BUTTON_VALUE),
    threadTs: body?.message?.thread_ts || undefined,
  }
  const message: CachedMessage = { text: body?.message?.text ?? '', blocks: body?.message?.blocks ?? [] }
  const key = routeKey(route)
  if (deps.forwarded.has(key)) {
    // Spent already. Say so, since the button may still be on screen if an
    // earlier update failed or raced, and try once more to take it down.
    await tellUser(deps, channel, userId, 'Already chosen.')
    await updateMessage(deps, route, message, null)
    return 'duplicate'
  }
  if (decoded.prompt !== undefined) {
    return openReplyBox(deps, String(body?.trigger_id ?? ''), route, decoded.prompt, message, userId)
  }

  spend(deps.forwarded, key)
  const userName = await forward(deps, route, userId, `[button] ${route.label}`, {}, 'button click')
  await updateMessage(deps, route, message, `✓ ${userName} chose "${route.label}"`)
  return 'forwarded'
}

/** Opens the reply box first: Slack's trigger_id dies three seconds after the
 *  click, so nothing slow (name lookups, message updates) may run before it.
 *  Opening spends nothing; the owner can cancel and click again. */
async function openReplyBox(
  deps: ActClickDeps,
  triggerId: string,
  route: ButtonRoute,
  prompt: string,
  message: CachedMessage,
  userId: string,
): Promise<ActClickOutcome> {
  try {
    await deps.openView({ trigger_id: triggerId, view: buildReplyView(route, prompt) })
  } catch {
    await tellUser(deps, route.channel, userId, 'Could not open the reply box. Click the button again.')
    return 'failed'
  }
  const key = routeKey(route)
  deps.replyCache.delete(key)
  deps.replyCache.set(key, message)
  for (const oldest of deps.replyCache.keys()) {
    if (deps.replyCache.size <= REPLY_CACHE_CAP) break
    deps.replyCache.delete(oldest)
  }
  return 'opened'
}

export function buildReplyView(route: ButtonRoute, prompt: string): Block {
  return {
    type: 'modal',
    callback_id: REPLY_VIEW_CALLBACK,
    private_metadata: encodeReplyMetadata(route),
    title: { type: 'plain_text', text: 'Reply' },
    submit: { type: 'plain_text', text: 'Send' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: REPLY_BLOCK,
        label: { type: 'plain_text', text: prompt },
        element: { type: 'plain_text_input', action_id: REPLY_INPUT, multiline: true, max_length: MAX_REPLY_TEXT },
      },
    ],
  }
}

/** The whole route rides in the view's private_metadata rather than in a
 *  bridge-side map, because Slack hands it back on submission: a reply sent
 *  after a bridge restart still knows where it goes and which button it
 *  spends. Only the value can be long enough to break Slack's limit (and only
 *  when JSON escaping inflates it), so it alone is trimmed until the JSON fits. */
export function encodeReplyMetadata(route: ButtonRoute): string {
  const fields: Record<string, string> = {
    c: route.channel,
    t: route.messageTs,
    a: route.actionId,
    l: route.label,
    v: route.value,
  }
  if (route.threadTs) fields.th = route.threadTs
  let json = JSON.stringify(fields)
  while (json.length > MAX_VIEW_METADATA && fields.v) {
    let v = fields.v.slice(0, Math.max(0, fields.v.length - (json.length - MAX_VIEW_METADATA)))
    // Never leave half of a surrogate pair at the cut.
    if (/[\uD800-\uDBFF]$/.test(v)) v = v.slice(0, -1)
    fields.v = v
    json = JSON.stringify(fields)
  }
  return json
}

function decodeReplyMetadata(raw: unknown): ButtonRoute | null {
  let f: Record<string, unknown>
  try {
    f = JSON.parse(String(raw))
  } catch {
    return null
  }
  const str = (x: unknown) => (typeof x === 'string' ? x : '')
  const route: ButtonRoute = {
    channel: str(f?.c),
    messageTs: str(f?.t),
    actionId: str(f?.a),
    label: str(f?.l),
    value: str(f?.v),
    threadTs: str(f?.th) || undefined,
  }
  return route.channel && route.messageTs && isPromptAction(route.actionId) ? route : null
}

/** Handle one `view_submission` from a reply box. The caller has already
 *  acknowledged it, which closes the box. Same order as a click: owner check,
 *  synchronous spend, notify (un-spending on failure), then a best-effort
 *  update of the original message, skipped when its snapshot is gone. */
// biome-ignore lint/suspicious/noExplicitAny: interaction payloads are untyped JSON from Slack
export async function handleReplySubmission(deps: ActClickDeps, body: any): Promise<ActClickOutcome> {
  const view = body?.view
  const route = view?.callback_id === REPLY_VIEW_CALLBACK ? decodeReplyMetadata(view?.private_metadata) : null
  const userId: string = body?.user?.id ?? ''
  const raw = view?.state?.values?.[REPLY_BLOCK]?.[REPLY_INPUT]?.value
  const text = typeof raw === 'string' ? raw.slice(0, MAX_REPLY_TEXT) : ''
  if (!route || !SLACK_ID.test(userId) || !text.trim()) return 'ignored'

  if (!deps.allowFrom().includes(userId)) {
    await tellUser(deps, route.channel, userId, 'Only the session owner can use these buttons.')
    return 'refused'
  }

  const key = routeKey(route)
  const cached = deps.replyCache.get(key)
  if (deps.forwarded.has(key)) {
    await tellUser(deps, route.channel, userId, 'Already chosen.')
    if (cached) await updateMessage(deps, route, cached, null)
    return 'duplicate'
  }
  spend(deps.forwarded, key)
  let userName: string
  try {
    const content = `[button] ${route.label}\n\n${text}`
    userName = await forward(deps, route, userId, content, { reply_text: text }, 'button reply')
  } catch (err) {
    // The box is already closed, so say the text was lost rather than drop it silently.
    await tellUser(deps, route.channel, userId, 'Your reply did not reach the session. Click the button to try again.')
    throw err
  }
  deps.replyCache.delete(key)
  if (cached) await updateMessage(deps, route, cached, `✓ ${userName} replied via "${route.label}"`)
  return 'forwarded'
}

/** Deliver a spent button to the session; returns the display name used. If
 *  notify throws, the input never reached the session, so the button is
 *  un-spent and a retry can go through. */
async function forward(
  deps: ActClickDeps,
  route: ButtonRoute,
  userId: string,
  content: string,
  extraMeta: Record<string, string>,
  reason: string,
): Promise<string> {
  const { channel, messageTs, threadTs } = route
  let userName = userId
  try {
    userName = await deps.resolveUserName(userId)
  } catch {
    /* fall back to the id */
  }
  const meta: Record<string, string> = {
    chat_id: channel,
    message_id: messageTs,
    user_id: userId,
    user: userName,
    ts: messageTs,
    action_value: route.value,
    ...extraMeta,
  }
  if (threadTs) meta.thread_ts = threadTs
  try {
    deps.recordInbound({ channel, threadTs, userId, messageTs, reason })
    await deps.notify({ content, meta })
  } catch (err) {
    deps.forwarded.delete(routeKey(route))
    throw err
  }
  return userName
}

/** Best-effort: the input already reached the session (or was spent before),
 *  so a Slack error here only leaves a dead button, which a re-click answers
 *  with "Already chosen." and another attempt. */
async function updateMessage(
  deps: ActClickDeps,
  route: ButtonRoute,
  message: CachedMessage,
  choiceLine: string | null,
): Promise<void> {
  const next = withoutSpentButtons(message.blocks, spentOn(deps, route), choiceLine ?? '')
  if (choiceLine === null) next.pop()
  try {
    await deps.update({ channel: route.channel, ts: route.messageTs, text: message.text, blocks: next })
  } catch {
    /* see above */
  }
}
