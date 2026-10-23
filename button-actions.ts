/**
 * button-actions.ts — session-posted buttons and their clicks.
 *
 * `send_actions` lets the session post a message with up to five buttons; a
 * click on one comes back into the session as a channel notification, the same
 * way an inbound message does. Kept out of server.ts so the click handler can be
 * unit-tested against fakes without the server's module-load side effects.
 *
 * Button action ids are `act:<n>`, disjoint from the bridge's own `perm:`
 * permission buttons, so neither path can resolve the other's clicks.
 */

import { z } from 'zod'

export const ACT_PREFIX = 'act:'
export const MAX_BUTTONS = 5
// Slack limits: section text 3000 chars, button text 75, button value 2000.
export const MAX_ACTION_TEXT = 2900
export const MAX_BUTTON_LABEL = 75
export const MAX_BUTTON_VALUE = 2000
// Bounds the in-memory dedupe set; a click older than this many forwards is
// long settled, and its button was removed from the message anyway.
export const FORWARDED_CAP = 5000

export type ButtonStyle = 'primary' | 'danger'

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
          })
          .strict(),
      )
      .min(1)
      .max(MAX_BUTTONS),
  })
  .strict()

export interface ActionButton {
  label: string
  value: string
  style?: ButtonStyle
}

// biome-ignore lint/suspicious/noExplicitAny: Slack Block Kit blocks are open-ended JSON
type Block = { type: string; [key: string]: any }

export function isActAction(actionId: string): boolean {
  return actionId.startsWith(ACT_PREFIX)
}

export function buildActionMessageBlocks(text: string, buttons: readonly ActionButton[]): Block[] {
  return [
    { type: 'section', text: { type: 'mrkdwn', text } },
    {
      type: 'actions',
      elements: buttons.map((b, i) => ({
        type: 'button',
        action_id: `${ACT_PREFIX}${i}`,
        text: { type: 'plain_text', text: b.label, emoji: true },
        value: b.value,
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

export interface ActClickDeps {
  allowFrom: () => readonly string[]
  forwarded: Set<string>
  resolveUserName: (userId: string) => Promise<string>
  /** Bookkeeping the server does for any input that reaches the session: the
   *  outbound gate's delivered-threads set, the permission relay's last active
   *  thread, the audit journal. Called just before notify. */
  recordInbound: (args: { channel: string; threadTs: string | undefined; userId: string; messageTs: string }) => void
  notify: (params: { content: string; meta: Record<string, string> }) => Promise<void> | void
  update: (args: { channel: string; ts: string; text: string; blocks: Block[] }) => Promise<unknown>
  postEphemeral: (args: { channel: string; user: string; text: string }) => Promise<unknown>
}

export type ActClickOutcome = 'ignored' | 'refused' | 'duplicate' | 'forwarded'

const SLACK_ID = /^[A-Z0-9]{1,32}$/

/** Handle one `block_actions` payload for an `act:` button. The caller has
 *  already acknowledged the interaction. Order matters:
 *  owner check, then the synchronous dedupe write (before any await, so a
 *  concurrent duplicate sees it), then notify, then the message update, which
 *  is best-effort so a Slack error can never swallow the click. */
// biome-ignore lint/suspicious/noExplicitAny: interaction payloads are untyped JSON from Slack
export async function handleActClick(deps: ActClickDeps, body: any): Promise<ActClickOutcome> {
  const action = body?.actions?.[0]
  const actionId: string = action?.action_id ?? ''
  const channel: string = body?.channel?.id ?? ''
  const messageTs: string = body?.message?.ts ?? ''
  const userId: string = body?.user?.id ?? ''
  if (!isActAction(actionId) || !channel || !messageTs || !SLACK_ID.test(userId)) return 'ignored'

  if (!deps.allowFrom().includes(userId)) {
    try {
      await deps.postEphemeral({ channel, user: userId, text: 'Only the session owner can use these buttons.' })
    } catch {
      /* non-critical */
    }
    return 'refused'
  }

  const keyOf = (id: string) => `${channel}:${messageTs}:${id}`
  const key = keyOf(actionId)
  if (deps.forwarded.has(key)) {
    // Spent already. Say so, since the button may still be on screen if an
    // earlier update failed or raced, and try once more to take it down.
    try {
      await deps.postEphemeral({ channel, user: userId, text: 'Already chosen.' })
    } catch {
      /* non-critical */
    }
    await updateMessage(deps, body, channel, messageTs, (id) => deps.forwarded.has(keyOf(id)), null)
    return 'duplicate'
  }
  deps.forwarded.add(key)
  for (const oldest of deps.forwarded) {
    if (deps.forwarded.size <= FORWARDED_CAP) break
    deps.forwarded.delete(oldest)
  }

  const label: string = String(action?.text?.text ?? actionId).slice(0, MAX_BUTTON_LABEL)
  const value: string = String(action?.value ?? '').slice(0, MAX_BUTTON_VALUE)
  // Only a message that really sits in a thread reports one, exactly like an
  // inbound message; inventing one from the message ts would point the session
  // at a thread the outbound gate never saw.
  const threadTs: string | undefined = body?.message?.thread_ts || undefined
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
    action_value: value,
  }
  if (threadTs) meta.thread_ts = threadTs

  try {
    deps.recordInbound({ channel, threadTs, userId, messageTs })
    await deps.notify({ content: `[button] ${label}`, meta })
  } catch (err) {
    // The click never reached the session: un-spend the button so a retry can.
    deps.forwarded.delete(key)
    throw err
  }

  await updateMessage(
    deps,
    body,
    channel,
    messageTs,
    (id) => deps.forwarded.has(keyOf(id)),
    `✓ ${userName} chose "${label}"`,
  )
  return 'forwarded'
}

/** Best-effort: the click already reached the session (or was spent before),
 *  so a Slack error here only leaves a dead button, which a re-click answers
 *  with "Already chosen." and another attempt. */
async function updateMessage(
  deps: ActClickDeps,
  // biome-ignore lint/suspicious/noExplicitAny: interaction payloads are untyped JSON from Slack
  body: any,
  channel: string,
  messageTs: string,
  isSpent: (actionId: string) => boolean,
  choiceLine: string | null,
): Promise<void> {
  const blocks: Block[] = body?.message?.blocks ?? []
  const next = withoutSpentButtons(blocks, isSpent, choiceLine ?? '')
  if (choiceLine === null) next.pop()
  try {
    await deps.update({ channel, ts: messageTs, text: body?.message?.text ?? '', blocks: next })
  } catch {
    /* see above */
  }
}
