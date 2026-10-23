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
 * can resolve the other's clicks. Scope, gating and dedupe are recorded in
 * ADR-004 Decision 2b and 000-docs/session-state-machine.md.
 */

import { z } from 'zod'
import { type Access, decideInteractionRoute } from './lib.ts'

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
// The metadata escapes the value exactly as the button's envelope does, and the
// envelope must fit in 2000, so the escaped value is under 2000 and the whole
// metadata (plus a label of at most 75 chars escaped up to 6x, plus routing ids)
// stays near 2600: a button that passes SendActionsInput always fits.
export const MAX_VIEW_METADATA = 3000
export const MAX_REPLY_TEXT = 3000
export const REPLY_VIEW_CALLBACK = 'act_reply'
const REPLY_BLOCK = 'reply'
const REPLY_INPUT = 'text'
// Bounds the in-memory dedupe set; a click older than this many forwards is
// long settled, and its button was removed from the message anyway.
export const FORWARDED_CAP = 5000
// Bounds the message snapshots. Losing one only costs the cosmetic message
// update (skipped, or built on the click's payload); the input still goes through.
export const MESSAGE_CACHE_CAP = 200

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
export function sendActionsOutboundText(args: {
  text: string
  buttons: readonly ActionButton[]
}): string {
  return [args.text, ...args.buttons.flatMap((b) => [b.label, b.value, b.prompt ?? ''])].join('\n')
}

// any: Slack Block Kit blocks are open-ended JSON
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
function decodeButtonValue(
  actionId: string,
  raw: string,
): { value: string; prompt?: string } | null {
  if (!isPromptAction(actionId)) return { value: raw }
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed?.v === 'string' && typeof parsed?.p === 'string')
      return { value: parsed.v, prompt: parsed.p }
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

/** A message's text and blocks, as last seen or last written by the bridge. */
export interface CachedMessage {
  text: string
  blocks: Block[]
}

export type InteractionSource = 'block_actions' | 'view_submission'

export interface ActClickDeps {
  access: () => Access
  /** The inbound gate's engaged-threads set, for requireMention channels. */
  engagedThreads: ReadonlySet<string>
  forwarded: Set<string>
  /** Spent keys whose forward has not settled; a duplicate must not take the
   *  button down while the forward might still fail and un-spend it. */
  pending: Set<string>
  resolveUserName: (userId: string) => Promise<string>
  /** Bookkeeping the server does for any input that reaches the session, as
   *  for a delivered message: engaged and delivered threads, the deliver
   *  journal event with its session key, supervisor activation, and the
   *  permission relay's last active thread. Awaited just before notify. */
  recordInbound: (args: {
    channel: string
    threadTs: string | undefined
    messageTs: string
    userId: string
    source: InteractionSource
    actionId: string
  }) => Promise<void> | void
  /** Journals a refused or duplicate interaction. */
  recordDrop: (args: {
    channel: string
    userId: string
    source: InteractionSource
    reason: string
  }) => void
  notify: (params: { content: string; meta: Record<string, string> }) => Promise<void> | void
  update: (args: { channel: string; ts: string; text: string; blocks: Block[] }) => Promise<unknown>
  postEphemeral: (args: { channel: string; user: string; text: string }) => Promise<unknown>
  openView: (args: { trigger_id: string; view: Block }) => Promise<unknown>
  /** Latest blocks of each message the bridge handled, keyed `channel:ts`, so
   *  every update builds on the previous one instead of a stale payload. */
  messages: Map<string, CachedMessage>
}

export type ActClickOutcome =
  | 'ignored'
  | 'refused'
  | 'duplicate'
  | 'forwarded'
  | 'opened'
  | 'failed'

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

const keyOf = (channel: string, messageTs: string, actionId: string) =>
  `${channel}:${messageTs}:${actionId}`
const routeKey = (r: ButtonRoute) => keyOf(r.channel, r.messageTs, r.actionId)
const messageKey = (r: ButtonRoute) => `${r.channel}:${r.messageTs}`
const spentOn = (deps: ActClickDeps, r: ButtonRoute) => (id: string) =>
  deps.forwarded.has(keyOf(r.channel, r.messageTs, id))

function remember(deps: ActClickDeps, key: string, message: CachedMessage): void {
  deps.messages.delete(key)
  deps.messages.set(key, message)
  for (const oldest of deps.messages.keys()) {
    if (deps.messages.size <= MESSAGE_CACHE_CAP) break
    deps.messages.delete(oldest)
  }
}

/** Mark a button used and its forward in flight. Synchronous, and every caller
 *  runs it straight after its spent check with no await between, so a
 *  concurrent duplicate sees it. */
function spend(deps: ActClickDeps, key: string): void {
  deps.forwarded.add(key)
  deps.pending.add(key)
  for (const oldest of deps.forwarded) {
    if (deps.forwarded.size <= FORWARDED_CAP) break
    deps.forwarded.delete(oldest)
  }
}

async function tellUser(
  deps: ActClickDeps,
  channel: string,
  user: string,
  text: string,
): Promise<void> {
  try {
    await deps.postEphemeral({ channel, user, text })
  } catch {
    /* non-critical */
  }
}

/** Why this interaction may not reach the session, or null when it may. Two
 *  checks, both synchronous: the top-level allowFrom owner check, then the
 *  same gate a #287 option-button click passes (channel opt-in, per-channel
 *  allowFrom, DM pairing, requireMention via engaged threads). The owner check
 *  is the stricter of the two for a channel with an empty allowFrom. */
function refusal(
  deps: ActClickDeps,
  route: ButtonRoute,
  userId: string,
  actionTs: string,
): { reason: string; text: string } | null {
  const access = deps.access()
  if (!access.allowFrom.includes(userId)) {
    return {
      reason: 'interaction.not_owner',
      text: 'Only the session owner can use these buttons.',
    }
  }
  const decision = decideInteractionRoute(
    {
      actionType: 'button',
      userId,
      channelId: route.channel,
      actionTs,
      messageTs: route.messageTs,
      threadTs: route.threadTs,
    },
    access,
    deps.engagedThreads,
  )
  if (decision.action === 'deliver') return null
  return {
    reason: decision.dropReason,
    text: `Not delivered: the session does not take input here (${decision.dropReason}).`,
  }
}

async function refuse(
  deps: ActClickDeps,
  route: ButtonRoute,
  userId: string,
  source: InteractionSource,
  refused: { reason: string; text: string },
): Promise<ActClickOutcome> {
  deps.recordDrop({ channel: route.channel, userId, source, reason: refused.reason })
  await tellUser(deps, route.channel, userId, refused.text)
  return 'refused'
}

/** Spent already. Say so, since the button may still be on screen if an
 *  earlier update failed or raced, and try once more to take it down, unless
 *  the forward that spent it is still in flight and might yet un-spend it. */
async function alreadyChosen(
  deps: ActClickDeps,
  route: ButtonRoute,
  userId: string,
  source: InteractionSource,
  payload: CachedMessage | undefined,
): Promise<ActClickOutcome> {
  deps.recordDrop({
    channel: route.channel,
    userId,
    source,
    reason: 'interaction.already_consumed',
  })
  await tellUser(deps, route.channel, userId, 'Already chosen.')
  if (!deps.pending.has(routeKey(route))) await updateMessage(deps, route, payload, null)
  return 'duplicate'
}

/** Handle one `block_actions` payload for an `act:` button. The caller has
 *  already acknowledged the interaction. Order matters: owner check and
 *  interaction gate, then the synchronous dedupe write (before any await, so a
 *  concurrent duplicate sees it), then notify, then the message update, which
 *  is best-effort so a Slack error can never swallow the click. A reply-box
 *  button opens its box instead and is spent only when the reply is sent. */
// any: interaction payloads are untyped JSON from Slack
export async function handleActClick(deps: ActClickDeps, body: any): Promise<ActClickOutcome> {
  const action = body?.actions?.[0]
  const actionId: string = action?.action_id ?? ''
  const channel: string = body?.channel?.id ?? ''
  const messageTs: string = body?.message?.ts ?? ''
  const userId: string = body?.user?.id ?? ''
  const decoded = decodeButtonValue(actionId, String(action?.value ?? ''))
  if (!isActAction(actionId) || !channel || !messageTs || !SLACK_ID.test(userId) || !decoded)
    return 'ignored'

  const route: ButtonRoute = {
    channel,
    messageTs,
    actionId,
    label: String(action?.text?.text ?? actionId).slice(0, MAX_BUTTON_LABEL),
    value: decoded.value.slice(0, MAX_BUTTON_VALUE),
    threadTs: body?.message?.thread_ts || undefined,
  }
  const refused = refusal(deps, route, userId, String(action?.action_ts ?? ''))
  if (refused) return refuse(deps, route, userId, 'block_actions', refused)

  const payload: CachedMessage = {
    text: body?.message?.text ?? '',
    blocks: body?.message?.blocks ?? [],
  }
  const key = routeKey(route)
  if (deps.forwarded.has(key)) return alreadyChosen(deps, route, userId, 'block_actions', payload)
  if (decoded.prompt !== undefined) {
    return openReplyBox(
      deps,
      String(body?.trigger_id ?? ''),
      route,
      decoded.prompt,
      payload,
      userId,
    )
  }

  spend(deps, key)
  const userName = await forward(deps, route, userId, `[button] ${route.label}`, 'block_actions')
  await updateMessage(deps, route, payload, `✓ ${userName} chose "${route.label}"`)
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
  payload: CachedMessage,
  userId: string,
): Promise<ActClickOutcome> {
  const view = buildReplyView(route, prompt)
  try {
    // Unreachable for a button that passed SendActionsInput (see
    // MAX_VIEW_METADATA); refusing beats letting Slack reject or cut the route.
    if (view.private_metadata.length > MAX_VIEW_METADATA) throw new Error('metadata too long')
    await deps.openView({ trigger_id: triggerId, view })
  } catch {
    await tellUser(
      deps,
      route.channel,
      userId,
      'Could not open the reply box. Click the button again.',
    )
    return 'failed'
  }
  // The bridge's own last write, when there is one, is newer than any payload.
  const key = messageKey(route)
  if (!deps.messages.has(key)) remember(deps, key, payload)
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
        element: {
          type: 'plain_text_input',
          action_id: REPLY_INPUT,
          multiline: true,
          max_length: MAX_REPLY_TEXT,
        },
      },
    ],
  }
}

/** The whole route rides in the view's private_metadata rather than in a
 *  bridge-side map, because Slack hands it back on submission: a reply sent
 *  after a bridge restart still knows where it goes and which button it
 *  spends. It is routing only; the submission is re-gated on arrival. */
export function encodeReplyMetadata(route: ButtonRoute): string {
  const fields: Record<string, string> = {
    c: route.channel,
    t: route.messageTs,
    a: route.actionId,
    l: route.label,
    v: route.value,
  }
  if (route.threadTs) fields.th = route.threadTs
  return JSON.stringify(fields)
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

// any: interaction payloads are untyped JSON from Slack
function replyText(body: any): string {
  const raw = body?.view?.state?.values?.[REPLY_BLOCK]?.[REPLY_INPUT]?.value
  return typeof raw === 'string' ? raw.slice(0, MAX_REPLY_TEXT) : ''
}

/** Errors to show in the reply box instead of closing it, or null. Run before
 *  the ack, since only the ack can keep the box open: Slack's required flag
 *  accepts a reply of nothing but whitespace, which would otherwise vanish. */
// any: interaction payloads are untyped JSON from Slack
export function replySubmissionErrors(body: any): Record<string, string> | null {
  return replyText(body).trim() ? null : { [REPLY_BLOCK]: 'Type a reply before sending.' }
}

/** Handle one `view_submission` from a reply box. The caller has already
 *  acknowledged it, which closes the box. Same order as a click: owner check
 *  and interaction gate (re-run, since either may have changed while the box
 *  was open), synchronous spend, notify (un-spending on failure), then a
 *  best-effort update of the original message, skipped when its snapshot is
 *  gone. */
export async function handleReplySubmission(
  deps: ActClickDeps,
  // any: interaction payloads are untyped JSON from Slack
  body: any,
): Promise<ActClickOutcome> {
  const view = body?.view
  const route =
    view?.callback_id === REPLY_VIEW_CALLBACK ? decodeReplyMetadata(view?.private_metadata) : null
  const userId: string = body?.user?.id ?? ''
  const text = replyText(body)
  if (!route || !SLACK_ID.test(userId) || !text.trim()) return 'ignored'

  // A submission has no action_ts; the view id is likewise unique per box.
  const refused = refusal(deps, route, userId, String(view?.id ?? ''))
  if (refused) return refuse(deps, route, userId, 'view_submission', refused)

  const key = routeKey(route)
  if (deps.forwarded.has(key))
    return alreadyChosen(deps, route, userId, 'view_submission', undefined)
  spend(deps, key)
  let userName: string
  try {
    const content = `[button] ${route.label}\n\n${text}`
    userName = await forward(deps, route, userId, content, 'view_submission')
  } catch (err) {
    // The box is already closed, so say the text was lost rather than drop it silently.
    await tellUser(
      deps,
      route.channel,
      userId,
      'Your reply did not reach the session. Click the button to try again.',
    )
    throw err
  }
  await updateMessage(deps, route, undefined, `✓ ${userName} replied via "${route.label}"`)
  return 'forwarded'
}

/** Deliver a spent button to the session; returns the display name used. If
 *  notify throws, the input never reached the session, so the button is
 *  un-spent and a retry can go through. Either way the forward is no longer
 *  in flight once this settles. */
async function forward(
  deps: ActClickDeps,
  route: ButtonRoute,
  userId: string,
  content: string,
  source: InteractionSource,
): Promise<string> {
  const { channel, messageTs, threadTs, actionId } = route
  const key = routeKey(route)
  try {
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
    }
    if (threadTs) meta.thread_ts = threadTs
    try {
      await deps.recordInbound({ channel, threadTs, messageTs, userId, source, actionId })
      await deps.notify({ content, meta })
    } catch (err) {
      deps.forwarded.delete(key)
      throw err
    }
    return userName
  } finally {
    deps.pending.delete(key)
  }
}

/** Best-effort: the input already reached the session (or was spent before),
 *  so a Slack error here only leaves a dead button, which a re-click answers
 *  with "Already chosen." and another attempt. Builds on the bridge's last
 *  write for this message when it has one, else on the payload, else skips;
 *  the result is remembered even if Slack rejects it, since it is the state
 *  the next update should build on. */
async function updateMessage(
  deps: ActClickDeps,
  route: ButtonRoute,
  payload: CachedMessage | undefined,
  choiceLine: string | null,
): Promise<void> {
  const key = messageKey(route)
  const base = deps.messages.get(key) ?? payload
  if (!base) return
  const blocks = withoutSpentButtons(base.blocks, spentOn(deps, route), choiceLine ?? '')
  if (choiceLine === null) blocks.pop()
  remember(deps, key, { text: base.text, blocks })
  try {
    await deps.update({ channel: route.channel, ts: route.messageTs, text: base.text, blocks })
  } catch {
    /* see above */
  }
}
