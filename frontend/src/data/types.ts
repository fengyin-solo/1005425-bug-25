/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  /** 每个动作允许从哪些状态发起：不在名单里的当前状态一律拦下，挡住越级与回退。 */
  actionFrom?: Record<string, string[]>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 削坡减载台账里的「已落实避险场所」：避险场所复核通过后挂进来，同一场所编号只挂一条。 */
export type ImplementedShelter = {
  id: number
  场所编号: string
  场所名称: string
  可容纳人数: number
  开放条件: string
  核验结果: string
  落实日期: string
  [field: string]: string | number
}
