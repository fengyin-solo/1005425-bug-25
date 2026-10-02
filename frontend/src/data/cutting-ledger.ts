import type { EntryRow, ImplementedShelter } from './types'

// 削坡减载的「已落实避险场所」联动台账：避险场所复核通过后挂入。
// 台账独立成表，和削坡工序清单分开放，避免两套字段互相污染。
const LEDGER_KEY = 'geohazard-patrol:cutting-implemented-shelters'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function initialLedger(): ImplementedShelter[] {
  return []
}

let ledgerCache: ImplementedShelter[] | null = null

function readLedger(): ImplementedShelter[] {
  if (ledgerCache !== null) {
    return ledgerCache
  }
  if (typeof window === 'undefined' || !window.localStorage) {
    ledgerCache = initialLedger()
    return ledgerCache
  }
  const raw = window.localStorage.getItem(LEDGER_KEY)
  if (!raw) {
    ledgerCache = initialLedger()
    return ledgerCache
  }
  try {
    ledgerCache = JSON.parse(raw) as ImplementedShelter[]
  } catch {
    ledgerCache = initialLedger()
  }
  return ledgerCache
}

function persist(rows: ImplementedShelter[]): void {
  ledgerCache = rows
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(LEDGER_KEY, JSON.stringify(rows))
  }
}

export function listImplementedShelters(): ImplementedShelter[] {
  return readLedger()
}

function today(): string {
  const now = new Date()
  const month = `${now.getMonth() + 1}`.padStart(2, '0')
  const day = `${now.getDate()}`.padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/**
 * 复核结果挂台账：同一场所编号只挂一条，重复复核不会新增。
 * 返回 true 表示本次新挂入，false 表示台账里已有该场所编号（幂等跳过）。
 */
export function appendImplementedShelter(row: EntryRow): boolean {
  const code = String(row['场所编号'] ?? '')
  const rows = readLedger()
  if (code !== '' && rows.some((item) => item.场所编号 === code)) {
    return false
  }
  const next = [
    ...rows,
    {
      id: rows.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1,
      场所编号: code,
      场所名称: String(row['场所名称'] ?? ''),
      可容纳人数: Number(row['可容纳人数']) || 0,
      开放条件: String(row['开放条件'] ?? ''),
      核验结果: '核验通过，可启用',
      落实日期: today(),
    },
  ]
  persist(next)
  return true
}

export function resetImplementedShelters(): ImplementedShelter[] {
  persist(initialLedger())
  return clone(ledgerCache as ImplementedShelter[])
}

/**
 * 首次播种：把示例数据里已经走过复核环节（可启用/已启用/已关闭）且人数有效的场所补进台账。
 * 幂等：台账里已有的场所编号不再重复挂；用户之后的操作结果不受影响。
 */
export function seedImplementedShelters(refugeRows: EntryRow[]): void {
  const rows = readLedger()
  const additions: ImplementedShelter[] = []
  let nextId = rows.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0)
  for (const row of refugeRows) {
    const reviewed = ['可启用', '已启用', '已关闭'].includes(String(row.status))
    if (!reviewed) {
      continue
    }
    const capacity = Number(row['可容纳人数'])
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      continue
    }
    const code = String(row['场所编号'] ?? '')
    if (code === '' || rows.some((item) => item.场所编号 === code)) {
      continue
    }
    nextId += 1
    additions.push({
      id: nextId,
      场所编号: code,
      场所名称: String(row['场所名称'] ?? ''),
      可容纳人数: capacity,
      开放条件: String(row['开放条件'] ?? ''),
      核验结果: '核验通过，可启用',
      落实日期: String(row['启用日期'] ?? '').trim() !== '' ? String(row['启用日期']) : '2026-09-02',
    })
  }
  if (additions.length > 0) {
    persist([...rows, ...additions])
  }
}

export function ledgerStorageKey(): string {
  return LEDGER_KEY
}
