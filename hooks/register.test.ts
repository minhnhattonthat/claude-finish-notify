import { test, expect } from 'claude-code/testing'

const turn = { answer: 'All done\n  here', durationMs: 5, turnId: 't1' }

test('popup runs on answer, not on abort or subagent turns', async ($, on) => {
  const runs: { argv: readonly string[]; env?: Record<string, string> }[] = []
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('session.cwd', async () => ({ value: 'C:\\work\\proj' }))
  on('process.spawn', async function* (_$, e) {
    runs.push(e)
    return { value: { code: 0, signal: null } }
  })

  await $.turn.complete({ ...turn, reason: 'answer', isAborted: false })
  await $.turn.complete({ ...turn, reason: 'aborted', isAborted: true })
  await $.turn.complete({ ...turn, reason: 'answer', isAborted: false, agentId: 'a1' })

  expect(runs.length).toBe(1)
  expect(runs[0].env?.CC_BODY).toBe('All done here')
  expect(runs[0].env?.CC_TITLE).toBe('proj')
})
