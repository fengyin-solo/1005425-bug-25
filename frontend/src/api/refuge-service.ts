import { appendImplementedShelter } from '@/data/cutting-ledger'
import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 避险场所领域服务：启用校验、状态流转、削坡减载台账联动全部收口在这一处。
// 列表侧栏（抽屉）与详情页共用同一份读取与判定逻辑，不再各写一套。
const REFUGE_KEY = 'refuge'

export const CAPACITY_FIELD = '可容纳人数'
export const OPENING_FIELD = '开放条件'
export const STATUS_FIELD = '场所状态'

// 开放条件只认这三种口径：别的写法（自由文本、空白）一律视为不满足。
export const OPENING_OPTIONS = ['常年开放', '汛期开放', '临险开放'] as const

export const REFUGE_STATUSES = ['待核验', '可启用', '已启用', '已关闭'] as const

/**
 * 启用判定优先级（人数与开放条件打架时按此顺序，先人数、后开放条件）：
 * 1. 可容纳人数是硬门槛，一票否决——
 *    - 缺失（没填）：拦下并提示补齐；
 *    - 无效（0、负数、小数、非数字）：一律退回重填；
 * 2. 人数有效后再看开放条件：必须命中约定口径（常年开放/汛期开放/临险开放），否则不启用。
 */
export type CapacityIssue =
  | { kind: 'valid'; value: number }
  | { kind: 'missing' }
  | { kind: 'invalid'; raw: string }

export function parseCapacity(raw: unknown): CapacityIssue {
  const text = String(raw ?? '').trim()
  if (text === '') {
    return { kind: 'missing' }
  }
  if (!/^\d+$/.test(text)) {
    return { kind: 'invalid', raw: text }
  }
  const value = Number(text)
  if (!Number.isSafeInteger(value) || value <= 0) {
    return { kind: 'invalid', raw: text }
  }
  return { kind: 'valid', value }
}

export function describeCapacity(raw: unknown): { tone: 'ok' | 'missing' | 'invalid'; text: string } {
  const parsed = parseCapacity(raw)
  if (parsed.kind === 'valid') {
    return { tone: 'ok', text: `${parsed.value} 人` }
  }
  if (parsed.kind === 'missing') {
    return { tone: 'missing', text: '待补齐' }
  }
  return { tone: 'invalid', text: `无效值（${parsed.raw}），退回重填` }
}

export function openingText(raw: unknown): string {
  return String(raw ?? '').trim()
}

export function isOpeningMet(raw: unknown): boolean {
  return (OPENING_OPTIONS as readonly string[]).includes(openingText(raw))
}

export function getRefuge(id: number): EntryRow | undefined {
  return listRows(REFUGE_KEY).find((row) => Number(row.id) === id)
}

export type EnableEvaluation = {
  canEnable: boolean
  reason: string
  capacity: ReturnType<typeof parseCapacity>
  openingMet: boolean
}

/** 读同一份开放条件与人数：抽屉、详情页、批量启用都走这个判定，不会两样。 */
export function evaluateEnable(row: EntryRow): EnableEvaluation {
  const capacity = parseCapacity(row[CAPACITY_FIELD])
  const openingMet = isOpeningMet(row[OPENING_FIELD])
  if (String(row.status) !== '可启用') {
    return {
      canEnable: false,
      reason: `当前为「${row.status}」，需先处于「可启用」环节才能确认启用`,
      capacity,
      openingMet,
    }
  }
  if (capacity.kind === 'missing') {
    return { canEnable: false, reason: '可容纳人数缺失，请补齐可容纳人数后再启用', capacity, openingMet }
  }
  if (capacity.kind === 'invalid') {
    return {
      canEnable: false,
      reason: `可容纳人数「${capacity.raw}」无效，请填大于 0 的正整数后重填`,
      capacity,
      openingMet,
    }
  }
  if (!openingMet) {
    const text = openingText(row[OPENING_FIELD])
    return {
      canEnable: false,
      reason: `开放条件${text === '' ? '未填写' : `「${text}」`}不在约定口径（常年开放/汛期开放/临险开放），暂不启用`,
      capacity,
      openingMet,
    }
  }
  return { canEnable: true, reason: '人数与开放条件均满足，可确认启用', capacity, openingMet }
}

function persist(rows: EntryRow[]): void {
  saveRows(REFUGE_KEY, rows)
}

function today(): string {
  const now = new Date()
  const month = `${now.getMonth() + 1}`.padStart(2, '0')
  const day = `${now.getDate()}`.padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function applyStatus(rows: EntryRow[], index: number, status: string): EntryRow[] {
  const current = rows[index]
  const next = [...rows]
  next[index] = {
    ...current,
    status,
    // 场所状态文本与流转状态保持一致，落库那份和明细读出来不会再对不上。
    [STATUS_FIELD]: status,
    pending: status === '待核验' || status === '可启用',
  }
  persist(next)
  return next
}

export function reviewRefuge(id: number): ActionResult {
  const rows = listRows(REFUGE_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的避险场所` }
  }
  const row = rows[index]
  const code = String(row['场所编号'] ?? id)
  const status = String(row.status)
  if (status === '可启用') {
    return { ok: false, message: `场所 ${code} 已核验通过，不用重复复核` }
  }
  if (status !== '待核验') {
    return { ok: false, message: `场所 ${code} 当前为「${status}」，越级操作已挡下，只有待核验场所能提交核验` }
  }
  const capacity = parseCapacity(row[CAPACITY_FIELD])
  if (capacity.kind === 'missing') {
    return { ok: false, message: `场所 ${code} 的可容纳人数缺失，请补齐后再提交核验` }
  }
  if (capacity.kind === 'invalid') {
    return { ok: false, message: `场所 ${code} 的可容纳人数「${capacity.raw}」无效，请填大于 0 的正整数后重填` }
  }
  applyStatus(rows, index, '可启用')
  // 复核结果落到削坡减载台账：同一场所编号只挂一条，重复复核不新增。
  const created = appendImplementedShelter(listRows(REFUGE_KEY)[index])
  const ledgerNote = created ? '，已挂入削坡减载「已落实场所」台账' : '，台账已有该场所编号，未重复挂入'
  return { ok: true, message: `场所 ${code} 核验通过，进入可启用${ledgerNote}` }
}

export function enableRefuge(id: number): ActionResult {
  const rows = listRows(REFUGE_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的避险场所` }
  }
  const row = rows[index]
  const code = String(row['场所编号'] ?? id)
  const evaluation = evaluateEnable(row)
  if (!evaluation.canEnable) {
    return { ok: false, message: `场所 ${code}：${evaluation.reason}` }
  }
  const nextRows = applyStatus(rows, index, '已启用')
  if (String(nextRows[index]['启用日期'] ?? '').trim() === '') {
    nextRows[index] = { ...nextRows[index], 启用日期: today() }
    persist(nextRows)
  }
  return { ok: true, message: `场所 ${code} 已确认启用` }
}

export function closeRefuge(id: number): ActionResult {
  const rows = listRows(REFUGE_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的避险场所` }
  }
  const row = rows[index]
  const code = String(row['场所编号'] ?? id)
  const status = String(row.status)
  if (status === '已关闭') {
    return { ok: false, message: `场所 ${code} 已关闭，不用重复操作` }
  }
  if (status !== '已启用') {
    return { ok: false, message: `场所 ${code} 当前为「${status}」，越级操作已挡下，只有已启用场所能办理关闭` }
  }
  applyStatus(rows, index, '已关闭')
  return { ok: true, message: `场所 ${code} 已办理关闭` }
}

export type PatchRefugeInput = {
  capacity?: string
  openCondition?: string
}

/** 抽屉 / 详情页保存编辑走同一个口子：无效人数一律退回重填，不允许落库。 */
export function patchRefuge(id: number, patch: PatchRefugeInput): ActionResult {
  const rows = listRows(REFUGE_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的避险场所` }
  }
  const row = rows[index]
  const code = String(row['场所编号'] ?? id)
  const updated: EntryRow = { ...row }

  if (patch.capacity !== undefined) {
    const text = patch.capacity.trim()
    const parsed = parseCapacity(text)
    if (parsed.kind === 'invalid') {
      return { ok: false, message: `可容纳人数「${parsed.raw}」无效，请填大于 0 的正整数后重填` }
    }
    updated[CAPACITY_FIELD] = parsed.kind === 'valid' ? parsed.value : ''
  }
  if (patch.openCondition !== undefined) {
    const text = openingText(patch.openCondition)
    if (text !== '' && !(OPENING_OPTIONS as readonly string[]).includes(text)) {
      return { ok: false, message: `开放条件「${text}」不在约定口径（常年开放/汛期开放/临险开放）内` }
    }
    updated[OPENING_FIELD] = text
  }

  const next = [...rows]
  next[index] = updated
  persist(next)
  return { ok: true, message: `场所 ${code} 已保存` }
}

export type ItemOutcome = {
  id: number
  code: string
  ok: boolean
  message: string
}

export type BatchOutcome = {
  kind: 'review' | 'enable'
  empty: boolean
  succeeded: number
  failed: number
  summary: string
  items: ItemOutcome[]
}

function runBatch(
  kind: 'review' | 'enable',
  expectedStatus: string,
  run: (id: number) => ActionResult,
  emptyMessage: string,
): BatchOutcome {
  const targets = listRows(REFUGE_KEY).filter((row) => String(row.status) === expectedStatus)
  if (targets.length === 0) {
    return { kind, empty: true, succeeded: 0, failed: 0, summary: emptyMessage, items: [] }
  }
  const items = targets.map((row) => {
    const id = Number(row.id)
    const result = run(id)
    return { id, code: String(row['场所编号'] ?? id), ok: result.ok, message: result.message }
  })
  const succeeded = items.filter((item) => item.ok).length
  const failed = items.length - succeeded
  const verb = kind === 'review' ? '核验' : '启用'
  const summary =
    failed === 0
      ? `本批 ${items.length} 条场所全部${verb}完成`
      : succeeded === 0
        ? `本批 ${items.length} 条场所均未通过${verb}，已逐条拦下，其他场所不受影响`
        : `本批 ${items.length} 条场所：${succeeded} 条${verb}通过，${failed} 条被单独拦下，未影响其他场所`
  return { kind, empty: false, succeeded, failed, summary, items }
}

/** 批量提交核验：人数缺失的单独拦下提示补齐、无效值退回重填，其余照常核验，不整批失败。 */
export function batchReview(): BatchOutcome {
  return runBatch('review', '待核验', reviewRefuge, '当前没有待核验的场所')
}

/** 批量确认启用：逐条兜住空值与无效值，同批其他场所照常启用；没有可启用场所时给空态说明。 */
export function batchEnable(): BatchOutcome {
  return runBatch(
    'enable',
    '可启用',
    enableRefuge,
    '当前没有可启用的场所：待核验场所需先通过复核进入可启用，已启用/已关闭场所无需重复操作',
  )
}

/** 当前状态允许执行的下一个动作：只放逐级流转，越级按钮不渲染（服务端同样挡死）。 */
export function nextActionFor(status: string): string {
  if (status === '待核验') {
    return '提交核验'
  }
  if (status === '可启用') {
    return '确认启用'
  }
  if (status === '已启用') {
    return '办理关闭'
  }
  return ''
}
