import { describe, expect, test } from 'bun:test'
import {
  type ActClickDeps,
  buildActionMessageBlocks,
  FORWARDED_CAP,
  handleActClick,
  isActAction,
  SendActionsInput,
  withoutSpentButtons,
} from './button-actions.ts'

const OWNER = 'U0OWNER0001'
const STRANGER = 'U0STRANGER1'

function fakes(overrides: Partial<ActClickDeps> = {}) {
  const calls = { notify: [] as any[], update: [] as any[], ephemeral: [] as any[], inbound: [] as any[] }
  const deps: ActClickDeps = {
    allowFrom: () => [OWNER],
    forwarded: new Set<string>(),
    resolveUserName: async () => 'Owner',
    recordInbound: (a) => {
      calls.inbound.push(a)
    },
    notify: async (p) => {
      calls.notify.push(p)
    },
    update: async (a) => {
      calls.update.push(a)
    },
    postEphemeral: async (a) => {
      calls.ephemeral.push(a)
    },
    ...overrides,
  }
  return { deps, calls }
}

const blocks = buildActionMessageBlocks('*Pixel check* needed', [
  { label: 'More info', value: 'more|PGM-410' },
  { label: 'Make a ticket', value: 'ticket|PGM-410', style: 'primary' },
  { label: 'Dismiss', value: 'dismiss|PGM-410', style: 'danger' },
])

function click(actionIndex: number, user = OWNER, extra: Record<string, unknown> = {}) {
  const el = blocks[1].elements[actionIndex]
  return {
    type: 'block_actions',
    user: { id: user },
    channel: { id: 'C0CHANNEL01' },
    message: { ts: '1791961914.000100', text: 'Pixel check needed', blocks, ...extra },
    actions: [{ action_id: el.action_id, value: el.value, text: el.text }],
  }
}

describe('buildActionMessageBlocks', () => {
  test('a section with the text, then one button per entry with act: ids', () => {
    expect(blocks[0]).toEqual({ type: 'section', text: { type: 'mrkdwn', text: '*Pixel check* needed' } })
    expect(blocks[1].elements.map((e: any) => [e.action_id, e.value, e.style])).toEqual([
      ['act:0', 'more|PGM-410', undefined],
      ['act:1', 'ticket|PGM-410', 'primary'],
      ['act:2', 'dismiss|PGM-410', 'danger'],
    ])
  })

  test('act: and perm: ids are disjoint', () => {
    expect(isActAction('act:0')).toBe(true)
    expect(isActAction('perm:allow:abcde')).toBe(false)
  })
})

const only = (...ids: string[]) => (id: string) => ids.includes(id)

describe('withoutSpentButtons (law 5: the other buttons survive a click)', () => {
  test('removes only the spent button and appends the choice line', () => {
    const out = withoutSpentButtons(blocks, only('act:1'), '✓ Owner chose "Make a ticket"')
    expect(out[0]).toEqual(blocks[0])
    expect(out[1].elements).toEqual([blocks[1].elements[0], blocks[1].elements[2]])
    expect(out[2]).toEqual({
      type: 'context',
      elements: [{ type: 'plain_text', text: '✓ Owner chose "Make a ticket"', emoji: true }],
    })
  })

  test('drops the actions block once every button is used', () => {
    const out = withoutSpentButtons(blocks, only('act:0', 'act:1', 'act:2'), 'c')
    expect(out.some((b) => b.type === 'actions')).toBe(false)
    expect(out[0]).toEqual(blocks[0])
  })
})

describe('handleActClick', () => {
  test('forwards an owner click as a channel notification', async () => {
    const { deps, calls } = fakes()
    expect(await handleActClick(deps, click(0))).toBe('forwarded')
    expect(calls.notify).toEqual([
      {
        content: '[button] More info',
        meta: {
          chat_id: 'C0CHANNEL01',
          message_id: '1791961914.000100',
          user_id: OWNER,
          user: 'Owner',
          ts: '1791961914.000100',
          action_value: 'more|PGM-410',
        },
      },
    ])
    expect(calls.update[0].blocks[1].elements.map((e: any) => e.action_id)).toEqual(['act:1', 'act:2'])
  })

  test('a top-level message reports no thread, so the outbound gate matches what it saw', async () => {
    const { deps, calls } = fakes()
    await handleActClick(deps, click(0))
    expect('thread_ts' in calls.notify[0].meta).toBe(false)
    expect(calls.inbound).toEqual([
      { channel: 'C0CHANNEL01', threadTs: undefined, userId: OWNER, messageTs: '1791961914.000100' },
    ])
  })

  test('a click in a thread reports that thread to the session and the gate', async () => {
    const { deps, calls } = fakes()
    await handleActClick(deps, click(0, OWNER, { thread_ts: '1791960000.000001' }))
    expect(calls.notify[0].meta.thread_ts).toBe('1791960000.000001')
    expect(calls.inbound[0].threadTs).toBe('1791960000.000001')
  })

  test('a re-click on a spent button says so and takes it down again', async () => {
    const { deps, calls } = fakes()
    await handleActClick(deps, click(0))
    expect(await handleActClick(deps, click(0))).toBe('duplicate')
    expect(calls.notify.length).toBe(1)
    expect(calls.ephemeral.map((e) => e.text)).toEqual(['Already chosen.'])
    expect(calls.update[1].blocks[1].elements.map((e: any) => e.action_id)).toEqual(['act:1', 'act:2'])
  })

  test('a stale snapshot never brings back a button already used', async () => {
    const { deps, calls } = fakes()
    await handleActClick(deps, click(0))
    await handleActClick(deps, click(1)) // payload still shows act:0, as before the first update landed
    expect(calls.update[1].blocks[1].elements.map((e: any) => e.action_id)).toEqual(['act:2'])
  })

  test('law 2: a failed notify un-spends the button so a retry forwards', async () => {
    let fail = true
    const { deps, calls } = fakes({
      notify: async (p) => {
        if (fail) throw new Error('Not connected')
        calls.notify.push(p)
      },
    })
    await expect(handleActClick(deps, click(0))).rejects.toThrow('Not connected')
    expect(calls.update.length).toBe(0)
    fail = false
    expect(await handleActClick(deps, click(0))).toBe('forwarded')
    expect(calls.notify.length).toBe(1)
  })

  test('law 1: concurrent duplicates forward once', async () => {
    const { deps, calls } = fakes()
    const results = await Promise.all([handleActClick(deps, click(0)), handleActClick(deps, click(0))])
    expect(results.sort()).toEqual(['duplicate', 'forwarded'])
    expect(calls.notify.length).toBe(1)
  })

  test('law 1: different buttons on one message each forward', async () => {
    const { deps, calls } = fakes()
    await handleActClick(deps, click(0))
    await handleActClick(deps, click(1))
    expect(calls.notify.map((n) => n.meta.action_value)).toEqual(['more|PGM-410', 'ticket|PGM-410'])
  })

  test('law 2: a failing message update never swallows the click', async () => {
    const { deps, calls } = fakes({
      update: async () => {
        throw new Error('message_not_found')
      },
    })
    expect(await handleActClick(deps, click(0))).toBe('forwarded')
    expect(calls.notify.length).toBe(1)
  })

  test('law 2: a failing name lookup still forwards, under the user id', async () => {
    const { deps, calls } = fakes({
      resolveUserName: async () => {
        throw new Error('ratelimited')
      },
    })
    await handleActClick(deps, click(0))
    expect(calls.notify[0].meta.user).toBe(OWNER)
  })

  test('law 3: a non-owner click changes nothing and leaves the button usable', async () => {
    const { deps, calls } = fakes()
    expect(await handleActClick(deps, click(0, STRANGER))).toBe('refused')
    expect(calls.notify.length).toBe(0)
    expect(calls.update.length).toBe(0)
    expect(calls.inbound.length).toBe(0)
    expect(calls.ephemeral.length).toBe(1)
    expect(await handleActClick(deps, click(0))).toBe('forwarded')
  })

  test('law 6: a perm: payload is ignored', async () => {
    const { deps, calls } = fakes()
    const body = click(0)
    body.actions[0].action_id = 'perm:allow:abcde'
    expect(await handleActClick(deps, body)).toBe('ignored')
    expect(calls.notify.length + calls.update.length).toBe(0)
  })

  test('a malformed user id is ignored', async () => {
    const { deps, calls } = fakes({ allowFrom: () => ['<script>'] })
    expect(await handleActClick(deps, click(0, '<script>'))).toBe('ignored')
    expect(calls.notify.length).toBe(0)
  })

  test('the dedupe set stays bounded', async () => {
    const { deps } = fakes()
    for (let i = 0; i <= FORWARDED_CAP; i++) deps.forwarded.add(`k${i}`)
    await handleActClick(deps, click(0))
    expect(deps.forwarded.size).toBe(FORWARDED_CAP)
    expect(deps.forwarded.has('k0')).toBe(false)
  })
})

describe('SendActionsInput', () => {
  const ok = { chat_id: 'C1', text: 'hi', buttons: [{ label: 'More info', value: 'more|PGM-1' }] }

  test('accepts a valid call', () => {
    expect(SendActionsInput.safeParse(ok).success).toBe(true)
  })

  test("enforces Slack's limits", () => {
    const b = { label: 'x', value: 'y' }
    expect(SendActionsInput.safeParse({ ...ok, buttons: [] }).success).toBe(false)
    expect(SendActionsInput.safeParse({ ...ok, buttons: [b, b, b, b, b, b] }).success).toBe(false)
    expect(SendActionsInput.safeParse({ ...ok, text: 'a'.repeat(2901) }).success).toBe(false)
    expect(SendActionsInput.safeParse({ ...ok, buttons: [{ label: 'a'.repeat(76), value: 'v' }] }).success).toBe(false)
    expect(SendActionsInput.safeParse({ ...ok, buttons: [{ label: 'l', value: 'v'.repeat(2001) }] }).success).toBe(false)
    expect(SendActionsInput.safeParse({ ...ok, buttons: [{ label: 'l', value: 'v', style: 'link' }] }).success).toBe(false)
  })

  test('rejects unknown fields', () => {
    expect(SendActionsInput.safeParse({ ...ok, blocks: [] }).success).toBe(false)
    expect(SendActionsInput.safeParse({ ...ok, buttons: [{ label: 'l', value: 'v', url: 'x' }] }).success).toBe(false)
  })
})
