import type { EntryRow } from '@/data/types'

// 避险场所的业务规则集中在这里：状态顺序、人数校验、开放条件判定、与削坡减载台账的联动。
// 页面（侧栏 / 详情面板 / 复核抽屉）与通用动作流都只准走这一份判断，避免两处口径打架。

export const REFUGE_STATUSES = ['待核验', '可启用', '已启用', '已关闭'] as const

export const CAPACITY_FIELD = '可容纳人数'
export const OPEN_CONDITION_FIELD = '开放条件'

// 开放条件里出现这些措辞，一律视为当前不具备开放条件（子串命中即拦截；
// 「暴雨期间暂停开放，平时正常」这类条件句不含上述措辞，不会被误伤）。
const OPEN_BLOCKED_WORDS = ['暂不开放', '暂停使用', '停止开放', '封闭停用', '暂不启用']

// 可容纳人数只接受正整数：空值、0、负数、小数、非数字都是无效值，一律退回重填。
// 返回 null 表示无效；空值与 0/负数由调用方按场景给出不同提示。
export function parseCapacity(raw: unknown): number | null {
  if (raw === null || raw === undefined) {
    return null
  }
  const text = String(raw).trim()
  if (text === '' || !/^\d+$/.test(text)) {
    return null
  }
  const value = Number(text)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

export function isCapacityMissing(row: EntryRow): boolean {
  const raw = row[CAPACITY_FIELD]
  return raw === null || raw === undefined || String(raw).trim() === ''
}

export function capacityProblem(row: EntryRow): 'missing' | 'invalid' | null {
  if (isCapacityMissing(row)) {
    return 'missing'
  }
  return parseCapacity(row[CAPACITY_FIELD]) === null ? 'invalid' : null
}

// 开放条件的唯一读取口径：侧栏、详情面板、复核抽屉、启用门禁都经过这里，谁也不许自己再判一遍。
export function readOpenCondition(row: EntryRow): string {
  const raw = row[OPEN_CONDITION_FIELD]
  return raw === null || raw === undefined ? '' : String(raw).trim()
}

export function isOpenConditionReady(row: EntryRow): boolean {
  const text = readOpenCondition(row)
  if (text === '') {
    return false
  }
  return !OPEN_BLOCKED_WORDS.some((word) => text.includes(word))
}

export type GateResult = {
  pass: boolean
  reasons: { level: 'missing' | 'invalid' | 'blocked'; field: string; message: string }[]
}

// 启用门禁的优先级（两条规则打架时按此判定，顺序即优先级）：
// 1. 可容纳人数是硬指标：缺失 → 提示补齐；填了 0、负数或其他无效值 → 退回重填。这一步不过，直接拦下。
// 2. 人数有效后才看开放条件：开放条件未登记或载明当前不开放 → 不允许启用。
// 即「可容纳人数」优先于「开放条件」：人数缺失/无效时不再评价开放条件。
export function evaluateEnableGate(row: EntryRow): GateResult {
  const problem = capacityProblem(row)
  if (problem === 'missing') {
    return {
      pass: false,
      reasons: [
        { level: 'missing', field: CAPACITY_FIELD, message: `场所 ${codeOf(row)} 的可容纳人数未填写，请补齐后再启用` },
      ],
    }
  }
  if (problem === 'invalid') {
    return {
      pass: false,
      reasons: [
        { level: 'invalid', field: CAPACITY_FIELD, message: `场所 ${codeOf(row)} 的可容纳人数「${row[CAPACITY_FIELD]}」无效，必须为正整数，请退回重填` },
      ],
    }
  }
  if (!isOpenConditionReady(row)) {
    const text = readOpenCondition(row)
    return {
      pass: false,
      reasons: [
        {
          level: 'blocked',
          field: OPEN_CONDITION_FIELD,
          message:
            text === ''
              ? `场所 ${codeOf(row)} 的开放条件未登记，暂不具备启用条件`
              : `场所 ${codeOf(row)} 的开放条件载明当前不开放（${text}），暂不具备启用条件`,
        },
      ],
    }
  }
  return { pass: true, reasons: [] }
}

export function codeOf(row: EntryRow): string {
  const raw = row['场所编号']
  return raw === null || raw === undefined ? String(row.id) : String(raw)
}

// —— 削坡减载台账联动 ——
// 复核（提交核验）通过的场所，要在削坡减载模块落一条「已落实场所」。
// 同一个场所编号复核多少次都只挂一条：先按场所编号查重，存在就原样返回。

export const CUTTING_KEY = 'cutting'

export type LedgerEntry = {
  '工序编号': string
  所属工程: string
  削坡方量: string
  坡比要求: string
  开挖高程: string
  验收日期: string
  验收人: string
  工序状态: string
  场所编号: string
  场所名称: string
  落实状态: string
}

const LEDGER_MARKER = '已落实避险场所'

export function isCuttingLedgerRow(row: EntryRow): boolean {
  return String(row['落实状态'] ?? '') === LEDGER_MARKER
}

export function findCuttingLedgerRow(rows: EntryRow[], siteCode: string): EntryRow | undefined {
  return rows.find((row) => isCuttingLedgerRow(row) && String(row['场所编号']) === siteCode)
}

export function todayText(): string {
  return new Date().toISOString().slice(0, 10)
}

// 构造台账行但不落库，由调用方统一保存；同场所编号已存在时返回 null（只挂一条）。
export function buildCuttingLedgerEntry(site: EntryRow, existing: EntryRow[]): (EntryRow & LedgerEntry) | null {
  const code = codeOf(site)
  if (findCuttingLedgerRow(existing, code)) {
    return null
  }
  const id = existing.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  return {
    id,
    status: '已验收',
    pending: false,
    abnormal: false,
    '工序编号': `REFU-LG-${code}`,
    '所属工程': `避险场所复核落实（${code}）`,
    '削坡方量': '—',
    '坡比要求': '—',
    '开挖高程': '—',
    '验收日期': todayText(),
    '验收人': String(site['场所负责人'] ?? '—'),
    '工序状态': '已验收',
    '场所编号': code,
    '场所名称': String(site['场所名称'] ?? '—'),
    '落实状态': LEDGER_MARKER,
  }
}
