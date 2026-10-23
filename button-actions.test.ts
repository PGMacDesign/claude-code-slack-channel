import { describe, expect, test } from 'bun:test'
import {
  type ActClickDeps,
  buildActionMessageBlocks,
  encodeReplyMetadata,
  FORWARDED_CAP,
  handleActClick,
  handleReplySubmission,
  isActAction,
  MAX_VIEW_METADATA,
  REPLY_CACHE_CAP,
  REPLY_VIEW_CALLBACK,
  SendActionsInput,
  sendActionsOutboundText,
  withoutSpentButtons,
} from './button-actions.ts'
import { assertNoSecretValues } from './lib.ts'

const OWNER = 'U0OWNER0001'
const STRANGER = 'U0STRANGER1'

function fakes(overrides: Partial<ActClickDeps> = {}) {
  const calls = {
    notify: [] as any[],
    update: [] as any[],
    ephemeral: [] as any[],
    inbound: [] as any[],
    views: [] as any[],
  }
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
    openView: async (a) => {
      calls.views.push(a)
    },
    replyCache: new Map(),
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
    expect(blocks[0]).toEqual({
      type: 'section',
      text: { type: 'mrkdwn', text: '*Pixel check* needed' },
    })
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

const only =
  (...ids: string[]) =>
  (id: string) =>
    ids.includes(id)

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
    expect(calls.update[0].blocks[1].elements.map((e: any) => e.action_id)).toEqual([
      'act:1',
      'act:2',
    ])
  })

  test('a top-level message reports no thread, so the outbound gate matches what it saw', async () => {
    const { deps, calls } = fakes()
    await handleActClick(deps, click(0))
    expect('thread_ts' in calls.notify[0].meta).toBe(false)
    expect(calls.inbound).toEqual([
      {
        channel: 'C0CHANNEL01',
        threadTs: undefined,
        userId: OWNER,
        messageTs: '1791961914.000100',
        reason: 'button click',
      },
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
    expect(calls.update[1].blocks[1].elements.map((e: any) => e.action_id)).toEqual([
      'act:1',
      'act:2',
    ])
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
    const results = await Promise.all([
      handleActClick(deps, click(0)),
      handleActClick(deps, click(0)),
    ])
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
    expect(
      SendActionsInput.safeParse({ ...ok, buttons: [{ label: 'a'.repeat(76), value: 'v' }] })
        .success,
    ).toBe(false)
    expect(
      SendActionsInput.safeParse({ ...ok, buttons: [{ label: 'l', value: 'v'.repeat(2001) }] })
        .success,
    ).toBe(false)
    expect(
      SendActionsInput.safeParse({ ...ok, buttons: [{ label: 'l', value: 'v', style: 'link' }] })
        .success,
    ).toBe(false)
  })

  test('rejects unknown fields', () => {
    expect(SendActionsInput.safeParse({ ...ok, blocks: [] }).success).toBe(false)
    expect(
      SendActionsInput.safeParse({ ...ok, buttons: [{ label: 'l', value: 'v', url: 'x' }] })
        .success,
    ).toBe(false)
  })
})

const promptBlocks = buildActionMessageBlocks('*Pixel check* needed', [
  { label: 'Looks good', value: 'ok|PGM-410', style: 'primary' },
  { label: 'Change something', value: 'change|PGM-410', prompt: 'What should change?' },
  { label: 'Ask a question', value: 'ask|PGM-410', prompt: 'Your question' },
])

function promptClick(actionIndex: number, user = OWNER, extra: Record<string, unknown> = {}) {
  const el = promptBlocks[1].elements[actionIndex]
  return {
    type: 'block_actions',
    trigger_id: '1000000000.0000000001.fakefakefake',
    user: { id: user },
    channel: { id: 'C0CHANNEL01' },
    message: {
      ts: '1791961914.000200',
      text: 'Pixel check needed',
      blocks: promptBlocks,
      ...extra,
    },
    actions: [{ action_id: el.action_id, value: el.value, text: el.text }],
  }
}

function submission(view: any, text: string | undefined, user = OWNER) {
  return {
    type: 'view_submission',
    user: { id: user },
    view: {
      id: 'V0VIEW00001',
      callback_id: view.callback_id,
      private_metadata: view.private_metadata,
      state: { values: { reply: { text: { type: 'plain_text_input', value: text } } } },
    },
  }
}

/** Opens the reply box for button `i` as the owner and returns its view. */
async function openBox(
  deps: ActClickDeps,
  calls: { views: any[] },
  i = 1,
  extra: Record<string, unknown> = {},
) {
  expect(await handleActClick(deps, promptClick(i, OWNER, extra))).toBe('opened')
  return calls.views[calls.views.length - 1].view
}

describe('reply-box buttons', () => {
  test('a button with a prompt gets an act:<n>:m id and carries the prompt in its value', () => {
    expect(promptBlocks[1].elements.map((e: any) => [e.action_id, e.value])).toEqual([
      ['act:0', 'ok|PGM-410'],
      ['act:1:m', JSON.stringify({ v: 'change|PGM-410', p: 'What should change?' })],
      ['act:2:m', JSON.stringify({ v: 'ask|PGM-410', p: 'Your question' })],
    ])
    expect(isActAction('act:1:m')).toBe(true)
  })

  test('an owner click opens the box with the trigger id, the prompt as label, and the route', async () => {
    const { deps, calls } = fakes()
    const view = await openBox(deps, calls)
    expect(calls.views[0].trigger_id).toBe('1000000000.0000000001.fakefakefake')
    expect(view.callback_id).toBe(REPLY_VIEW_CALLBACK)
    expect(view.submit.text).toBe('Send')
    expect(view.blocks).toHaveLength(1)
    expect(view.blocks[0].label.text).toBe('What should change?')
    expect(view.blocks[0].element.multiline).toBe(true)
    expect(view.blocks[0].optional).toBeUndefined()
    expect(JSON.parse(view.private_metadata)).toEqual({
      c: 'C0CHANNEL01',
      t: '1791961914.000200',
      a: 'act:1:m',
      l: 'Change something',
      v: 'change|PGM-410',
    })
  })

  test('opening spends nothing, tells the session nothing, and can be repeated', async () => {
    const { deps, calls } = fakes()
    await openBox(deps, calls)
    expect(deps.forwarded.size).toBe(0)
    expect(calls.notify.length + calls.update.length + calls.inbound.length).toBe(0)
    await openBox(deps, calls)
    expect(calls.views.length).toBe(2)
  })

  test('a stranger gets the refusal and no box', async () => {
    const { deps, calls } = fakes()
    expect(await handleActClick(deps, promptClick(1, STRANGER))).toBe('refused')
    expect(calls.views.length).toBe(0)
    expect(calls.ephemeral.map((e) => e.text)).toEqual([
      'Only the session owner can use these buttons.',
    ])
  })

  test('a box that fails to open says so and leaves the button live', async () => {
    const { deps, calls } = fakes({
      openView: async () => {
        throw new Error('expired_trigger_id')
      },
    })
    expect(await handleActClick(deps, promptClick(1))).toBe('failed')
    expect(calls.ephemeral.length).toBe(1)
    expect(deps.forwarded.size).toBe(0)
    expect(deps.replyCache.size).toBe(0)
  })

  test('an unreadable envelope on an act:<n>:m button is ignored', async () => {
    const { deps, calls } = fakes()
    const body = promptClick(1)
    body.actions[0].value = 'not json'
    expect(await handleActClick(deps, body)).toBe('ignored')
    expect(calls.views.length + calls.ephemeral.length).toBe(0)
  })

  test('a submission forwards the label and the typed text once, then takes the button down', async () => {
    const { deps, calls } = fakes()
    const view = await openBox(deps, calls)
    expect(await handleReplySubmission(deps, submission(view, 'Make the header blue'))).toBe(
      'forwarded',
    )
    expect(calls.notify).toEqual([
      {
        content: '[button] Change something\n\nMake the header blue',
        meta: {
          chat_id: 'C0CHANNEL01',
          message_id: '1791961914.000200',
          user_id: OWNER,
          user: 'Owner',
          ts: '1791961914.000200',
          action_value: 'change|PGM-410',
          reply_text: 'Make the header blue',
        },
      },
    ])
    expect(calls.inbound[0].reason).toBe('button reply')
    expect(calls.update[0].ts).toBe('1791961914.000200')
    expect(calls.update[0].blocks[1].elements.map((e: any) => e.action_id)).toEqual([
      'act:0',
      'act:2:m',
    ])
    expect(calls.update[0].blocks[2].elements[0].text).toBe(
      '✓ Owner replied via "Change something"',
    )
    expect(deps.replyCache.size).toBe(0)
  })

  test('a reply from a threaded message reports that thread', async () => {
    const { deps, calls } = fakes()
    const view = await openBox(deps, calls, 1, { thread_ts: '1791960000.000001' })
    await handleReplySubmission(deps, submission(view, 'x'))
    expect(calls.notify[0].meta.thread_ts).toBe('1791960000.000001')
    expect(calls.inbound[0].threadTs).toBe('1791960000.000001')
  })

  test('a duplicate submission is not forwarded', async () => {
    const { deps, calls } = fakes()
    const view = await openBox(deps, calls)
    await handleReplySubmission(deps, submission(view, 'first'))
    expect(await handleReplySubmission(deps, submission(view, 'second'))).toBe('duplicate')
    expect(calls.notify.length).toBe(1)
    expect(calls.ephemeral.map((e) => e.text)).toEqual(['Already chosen.'])
  })

  test('two boxes opened on one button forward only the first submission, even concurrently', async () => {
    const { deps, calls } = fakes()
    const a = await openBox(deps, calls)
    const b = await openBox(deps, calls)
    const results = await Promise.all([
      handleReplySubmission(deps, submission(a, 'one')),
      handleReplySubmission(deps, submission(b, 'two')),
    ])
    expect(results.sort()).toEqual(['duplicate', 'forwarded'])
    expect(calls.notify.length).toBe(1)
  })

  test('once replied, a click on the same button says "Already chosen." and opens nothing', async () => {
    const { deps, calls } = fakes()
    const view = await openBox(deps, calls)
    await handleReplySubmission(deps, submission(view, 'done'))
    expect(await handleActClick(deps, promptClick(1))).toBe('duplicate')
    expect(calls.views.length).toBe(1)
    expect(calls.ephemeral.map((e) => e.text)).toEqual(['Already chosen.'])
  })

  test('a stranger submission is refused and leaves the button usable', async () => {
    const { deps, calls } = fakes()
    const view = await openBox(deps, calls)
    expect(await handleReplySubmission(deps, submission(view, 'mine now', STRANGER))).toBe(
      'refused',
    )
    expect(calls.notify.length + calls.inbound.length + calls.update.length).toBe(0)
    expect(calls.ephemeral[0]).toEqual({
      channel: 'C0CHANNEL01',
      user: STRANGER,
      text: 'Only the session owner can use these buttons.',
    })
    expect(await handleReplySubmission(deps, submission(view, 'ok'))).toBe('forwarded')
  })

  test('a failed notify un-spends the button and tells the owner, so a retry forwards', async () => {
    let fail = true
    const { deps, calls } = fakes({
      notify: async (p) => {
        if (fail) throw new Error('Not connected')
        calls.notify.push(p)
      },
    })
    const view = await openBox(deps, calls)
    await expect(handleReplySubmission(deps, submission(view, 'hello'))).rejects.toThrow(
      'Not connected',
    )
    expect(deps.forwarded.size).toBe(0)
    expect(calls.update.length).toBe(0)
    expect(calls.ephemeral[0].text).toContain('did not reach the session')
    fail = false
    expect(await handleReplySubmission(deps, submission(view, 'hello'))).toBe('forwarded')
    expect(calls.notify.length).toBe(1)
  })

  test('with the snapshot gone (bridge restarted), the reply still forwards and the update is skipped', async () => {
    const before = fakes()
    const view = await openBox(before.deps, before.calls)
    const { deps, calls } = fakes()
    expect(await handleReplySubmission(deps, submission(view, 'after restart'))).toBe('forwarded')
    expect(calls.notify[0].meta.reply_text).toBe('after restart')
    expect(calls.update.length).toBe(0)
  })

  test('a failing update never swallows the reply', async () => {
    const { deps, calls } = fakes({
      update: async () => {
        throw new Error('message_not_found')
      },
    })
    const view = await openBox(deps, calls)
    expect(await handleReplySubmission(deps, submission(view, 'x'))).toBe('forwarded')
  })

  test('foreign, malformed or empty submissions are ignored', async () => {
    const { deps, calls } = fakes()
    const view = await openBox(deps, calls)
    const ignored = [
      submission({ ...view, callback_id: 'someone_else' }, 'x'),
      submission({ ...view, private_metadata: 'not json' }, 'x'),
      submission(
        { ...view, private_metadata: JSON.stringify({ c: 'C0CHANNEL01', t: '1.2', a: 'act:0' }) },
        'x',
      ),
      submission(
        {
          ...view,
          private_metadata: JSON.stringify({ c: 'C0CHANNEL01', t: '1.2', a: 'perm:allow:x' }),
        },
        'x',
      ),
      submission(view, '   '),
      submission(view, undefined),
      submission(view, 'x', '<script>'),
    ]
    for (const body of ignored) expect(await handleReplySubmission(deps, body)).toBe('ignored')
    expect(calls.notify.length + calls.ephemeral.length).toBe(0)
  })

  test('the snapshot cache stays bounded', async () => {
    const { deps, calls } = fakes()
    for (let i = 0; i < REPLY_CACHE_CAP; i++) deps.replyCache.set(`k${i}`, { text: '', blocks: [] })
    await openBox(deps, calls)
    expect(deps.replyCache.size).toBe(REPLY_CACHE_CAP)
    expect(deps.replyCache.has('k0')).toBe(false)
  })
})

describe('encodeReplyMetadata', () => {
  const route = {
    channel: 'C0CHANNEL01',
    messageTs: '1791961914.000200',
    actionId: 'act:1:m',
    label: 'Change something',
    value: 'v',
    threadTs: undefined,
  }

  test('keeps a value that fits, and the thread only when there is one', () => {
    expect(JSON.parse(encodeReplyMetadata(route))).toEqual({
      c: 'C0CHANNEL01',
      t: '1791961914.000200',
      a: 'act:1:m',
      l: 'Change something',
      v: 'v',
    })
    expect(JSON.parse(encodeReplyMetadata({ ...route, threadTs: '1.1' })).th).toBe('1.1')
  })

  test("trims only the value until escaping fits Slack's limit", () => {
    const out = encodeReplyMetadata({ ...route, value: '"'.repeat(1900) })
    expect(out.length).toBeLessThanOrEqual(MAX_VIEW_METADATA)
    const parsed = JSON.parse(out)
    expect(parsed.l).toBe('Change something')
    expect(parsed.v.length).toBeGreaterThan(1000)
    expect(/^"+$/.test(parsed.v)).toBe(true)
  })

  test('never cuts a surrogate pair in half', () => {
    // 2913 value chars fit here, so the first cut lands between the halves of an emoji
    const out = encodeReplyMetadata({ ...route, value: `${'a'.repeat(2900)}${'😀'.repeat(100)}` })
    expect(out.length).toBeLessThanOrEqual(MAX_VIEW_METADATA)
    const v: string = JSON.parse(out).v
    expect(/[\uD800-\uDBFF]$/.test(v)).toBe(false)
    expect(v).toBe(`${'a'.repeat(2900)}${'😀'.repeat(6)}`)
  })
})

describe('send_actions prompts', () => {
  const ok = {
    chat_id: 'C1',
    text: 'hi',
    buttons: [{ label: 'Change', value: 'c', prompt: 'What should change?' }],
  }

  test('the schema accepts a prompt and rejects bad ones', () => {
    expect(SendActionsInput.safeParse(ok).success).toBe(true)
    const withPrompt = (prompt: unknown, value = 'c') => ({
      ...ok,
      buttons: [{ label: 'l', value, prompt }],
    })
    expect(SendActionsInput.safeParse(withPrompt('')).success).toBe(false)
    expect(SendActionsInput.safeParse(withPrompt('p'.repeat(150))).success).toBe(true)
    expect(SendActionsInput.safeParse(withPrompt('p'.repeat(151))).success).toBe(false)
    expect(SendActionsInput.safeParse(withPrompt(42)).success).toBe(false)
    // value and prompt share the 2000-char button value once enveloped
    expect(SendActionsInput.safeParse(withPrompt('p', 'v'.repeat(1990))).success).toBe(false)
  })

  test('the prompt goes through the outbound secret guard with the text, labels and values', () => {
    const secrets = new Set(['sekrit-fake-value-123'])
    const leaky = {
      text: 'hi',
      buttons: [{ label: 'l', value: 'v', prompt: 'paste sekrit-fake-value-123' }],
    }
    expect(sendActionsOutboundText(leaky)).toContain('sekrit-fake-value-123')
    expect(() => assertNoSecretValues(sendActionsOutboundText(leaky), secrets)).toThrow()
    expect(() => assertNoSecretValues(sendActionsOutboundText(ok), secrets)).not.toThrow()
  })
})
