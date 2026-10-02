import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'
import {
  CAPACITY_FIELD,
  CUTTING_KEY,
  REFUGE_STATUSES,
  buildCuttingLedgerEntry,
  capacityProblem,
  codeOf,
  evaluateEnableGate,
  isCuttingLedgerRow,
  parseCapacity,
  todayText,
} from '@/api/refuge-service'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export type BatchItemLevel = 'success' | 'skipped' | 'missing' | 'invalid' | 'blocked'

export type BatchItemResult = {
  id: number
  code: string
  ok: boolean
  level: BatchItemLevel
  message: string
}

export type BatchResult = {
  ok: boolean
  items: BatchItemResult[]
  successCount: number
  blockedCount: number
  message: string
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  // 削坡减载的列表/明细只放工序，联动挂入的场所台账由 cuttingLedgerRows() 单独读。
  const source = key === CUTTING_KEY ? cuttingWorkRows() : listRows(key)
  const matched = filterRows(source, filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// 顺序流转守卫：登记了 actionSources 的模块，动作只允许从指定源状态发起，越级直接挡下。
function guardTransition(meta: ModuleMeta, action: string, current: string, target: string): string | null {
  if (current === target) {
    return `${meta.entity}已经是「${target}」，不用重复操作`
  }
  const allowed = meta.actionSources?.[action]
  if (allowed && !allowed.includes(current)) {
    if (meta.key === 'refuge') {
      return `避险场所只能按「${REFUGE_STATUSES.join(' → ')}」逐级流转，当前「${current}」不能${action}`
    }
    return `${meta.entity}当前为「${current}」，不能越级${action}到「${target}」`
  }
  return null
}

// 避险场所动作的专项校验：返回非 null 即拦截，落库的那份必须先过这里。
function refuseGuard(action: string, row: EntryRow): string | null {
  if (action === '提交核验' || action === '确认启用') {
    const gate = evaluateEnableGate(row)
    if (!gate.pass) {
      return gate.reasons[0].message
    }
  }
  return null
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  const blocked = guardTransition(meta, action, current, target)
  if (blocked) {
    return { ok: false, message: blocked }
  }
  const domainBlocked = key === 'refuge' ? refuseGuard(action, rows[index]) : null
  if (domainBlocked) {
    return { ok: false, message: domainBlocked }
  }

  const updated: EntryRow = {
    ...rows[index],
    status: target,
    // 避险场所的「已启用」是稳定在用环节，不再算待处理；只有待核验、可启用挂起。
    pending: key === 'refuge' ? target === '待核验' || target === '可启用' : target !== meta.statuses[meta.statuses.length - 1],
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  if (key === 'refuge' && action === '确认启用') {
    // 启用日期以实际确认时间为准，避免与台账明细对不上。
    updated['启用日期'] = todayText()
  }

  let next = [...rows]
  next[index] = updated

  // 复核通过的场所，在削坡减载台账挂一条「已落实场所」；同一编号只挂一条。
  if (key === 'refuge' && action === '提交核验') {
    const cutting = listRows(CUTTING_KEY)
    const ledgerEntry = buildCuttingLedgerEntry(updated, cutting)
    if (ledgerEntry) {
      saveRows(CUTTING_KEY, [...cutting, ledgerEntry])
    }
  }

  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// 批量复核：逐条校验，不整批失败——可容纳人数缺失的单独拦下提示补齐，
// 填成 0/负数等无效值的退回重填；同批其他合格场所照常流转并挂台账。
// capacityDrafts 是抽屉里补填的人数；没传或传空仍按缺失处理。
export function batchReviewRefuge(
  ids: number[],
  capacityDrafts: Record<number, string> = {},
): BatchResult {
  const rows = listRows('refuge')
  const selected = ids
    .map((id) => rows.find((row) => Number(row.id) === id))
    .filter((row): row is EntryRow => Boolean(row))

  const items: BatchItemResult[] = []
  const passed: EntryRow[] = []
  const nextById = new Map<number, EntryRow>()

  for (const row of selected) {
    const id = Number(row.id)
    const code = codeOf(row)
    if (String(row.status) !== '待核验') {
      items.push({ id, code, ok: false, level: 'skipped', message: `场所 ${code} 当前为「${row.status}」，不在待核验环节，跳过` })
      continue
    }
    const draft = capacityDrafts[id]
    const effective = draft === undefined ? row : { ...row, [CAPACITY_FIELD]: draft }
    const problem = capacityProblem(effective)
    if (problem === 'missing') {
      items.push({ id, code, ok: false, level: 'missing', message: `场所 ${code} 的可容纳人数未填写，请补齐后再复核` })
      continue
    }
    if (problem === 'invalid') {
      items.push({ id, code, ok: false, level: 'invalid', message: `场所 ${code} 的可容纳人数「${effective[CAPACITY_FIELD]}」无效，必须为正整数，请退回重填` })
      continue
    }
    const updated: EntryRow = {
      ...row,
      [CAPACITY_FIELD]: parseCapacity(effective[CAPACITY_FIELD]) as number,
      status: '可启用',
      pending: true,
      abnormal: false,
    }
    nextById.set(id, updated)
    passed.push(updated)
    items.push({ id, code, ok: true, level: 'success', message: `场所 ${code} 复核通过，进入可启用` })
  }

  if (passed.length > 0) {
    saveRows('refuge', rows.map((row) => nextById.get(Number(row.id)) ?? row))
    const cutting = listRows(CUTTING_KEY)
    const ledgerEntries: EntryRow[] = []
    for (const site of passed) {
      const entry = buildCuttingLedgerEntry(site, [...cutting, ...ledgerEntries])
      if (entry) {
        ledgerEntries.push(entry)
      }
    }
    if (ledgerEntries.length > 0) {
      saveRows(CUTTING_KEY, [...cutting, ...ledgerEntries])
    }
  }

  const blockedCount = items.filter((item) => !item.ok && item.level !== 'skipped').length
  return {
    ok: blockedCount === 0,
    items,
    successCount: passed.length,
    blockedCount,
    message: summarizeBatch(passed.length, blockedCount, items),
  }
}

// 批量启用：门禁逐条判定（人数优先，再看开放条件），合格的照常启用，不合格的单独拦下。
export function batchEnableRefuge(ids: number[]): BatchResult {
  const rows = listRows('refuge')
  const selected = ids
    .map((id) => rows.find((row) => Number(row.id) === id))
    .filter((row): row is EntryRow => Boolean(row))

  const items: BatchItemResult[] = []
  const nextById = new Map<number, EntryRow>()

  for (const row of selected) {
    const id = Number(row.id)
    const code = codeOf(row)
    if (String(row.status) !== '可启用') {
      items.push({ id, code, ok: false, level: 'skipped', message: `场所 ${code} 当前为「${row.status}」，只能在可启用环节确认启用，跳过` })
      continue
    }
    const gate = evaluateEnableGate(row)
    if (!gate.pass) {
      const reason = gate.reasons[0]
      items.push({ id, code, ok: false, level: reason.level === 'blocked' ? 'blocked' : reason.level, message: reason.message })
      continue
    }
    nextById.set(id, {
      ...row,
      status: '已启用',
      pending: false,
      abnormal: false,
      '启用日期': todayText(),
    })
    items.push({ id, code, ok: true, level: 'success', message: `场所 ${code} 已确认启用` })
  }

  const passedCount = nextById.size
  if (passedCount > 0) {
    saveRows('refuge', rows.map((row) => nextById.get(Number(row.id)) ?? row))
  }

  const blockedCount = items.filter((item) => !item.ok && item.level !== 'skipped').length
  return {
    ok: blockedCount === 0,
    items,
    successCount: passedCount,
    blockedCount,
    message: summarizeBatch(passedCount, blockedCount, items),
  }
}

function summarizeBatch(successCount: number, blockedCount: number, items: BatchItemResult[]): string {
  if (items.length === 0) {
    return '没有选中任何场所'
  }
  const parts: string[] = []
  if (successCount > 0) {
    parts.push(`${successCount} 条已处理`)
  }
  if (blockedCount > 0) {
    parts.push(`${blockedCount} 条被拦下，请按提示补齐或退回重填`)
  }
  const skipped = items.filter((item) => item.level === 'skipped').length
  if (skipped > 0) {
    parts.push(`${skipped} 条不在当前环节已跳过`)
  }
  return parts.join('，')
}

// 削坡减载主表与避险场所联动挂入的「已落实场所」台账分开读，台账不混进工序明细。
export function cuttingWorkRows(): EntryRow[] {
  return listRows(CUTTING_KEY).filter((row) => !isCuttingLedgerRow(row))
}

export function cuttingLedgerRows(): EntryRow[] {
  return listRows(CUTTING_KEY).filter(isCuttingLedgerRow)
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  const source = key === CUTTING_KEY ? cuttingWorkRows() : listRows(key)
  for (const row of source) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    // 削坡减载里联动挂入的场所台账不计入工序登记量，避免复核场所后数字虚高。
    const entries = (rows[meta.key] ?? []).filter((row) => !(meta.key === CUTTING_KEY && isCuttingLedgerRow(row)))
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
