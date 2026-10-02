<template>
  <section class="page" data-module="refuge">
    <header class="page-head">
      <div>
        <h2>避险场所管理</h2>
        <p class="page-desc">维护避险场所，围绕场所编号、场所名称、可容纳人数、开放条件做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openDrawer('review')">批量复核 / 启用</button>
        <button class="btn" type="button" @click="exportRows">导出避险场所清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <!-- 侧栏与详情面板读的是同一个 rows（即 store 同一份落库记录），不会两样。 -->
    <div class="workspace">
      <aside class="workspace-side">
        <h3 class="side-title">场所列表（{{ rows.length }}）</h3>
        <ul v-if="rows.length" class="site-list">
          <li
            v-for="row in rows"
            :key="String(row.id)"
            :class="['site-item', { active: selectedId === Number(row.id) }]"
            @click="selectedId = Number(row.id)"
          >
            <span class="site-code">{{ row['场所编号'] }}</span>
            <span class="site-name">{{ row['场所名称'] ?? '—' }}</span>
            <span :class="['site-status', `st-${String(row.status)}`]">{{ row.status }}</span>
          </li>
        </ul>
        <p v-else class="empty-state side-empty">
          没有符合筛选条件的避险场所，可放宽检索条件或先登记避险场所
        </p>
      </aside>

      <article class="detail-panel">
        <template v-if="selected">
          <header class="detail-head">
            <div>
              <h3>{{ selected['场所名称'] ?? '—' }} <small>{{ selected['场所编号'] }}</small></h3>
              <span :class="['site-status', `st-${String(selected.status)}`]">{{ selected.status }}</span>
            </div>
            <div class="detail-actions">
              <button
                v-if="String(selected.status) === '待核验'"
                class="btn"
                type="button"
                @click="runAction('提交核验', selected)"
              >
                提交核验
              </button>
              <button
                v-if="String(selected.status) === '可启用'"
                class="btn primary"
                type="button"
                @click="runAction('确认启用', selected)"
              >
                确认启用
              </button>
              <button
                v-if="String(selected.status) === '已启用'"
                class="btn"
                type="button"
                @click="runAction('办理关闭', selected)"
              >
                办理关闭
              </button>
            </div>
          </header>

          <dl class="detail-grid">
            <div v-for="column in detailFields" :key="column" class="detail-cell">
              <dt>{{ column }}</dt>
              <dd :class="{ 'cell-bad': column === '可容纳人数' && capacityProblem(selected) !== null }">
                {{ detailValue(column) }}
              </dd>
            </div>
          </dl>

          <section class="gate-box">
            <h4>启用门禁判定（优先级：可容纳人数 ＞ 开放条件）</h4>
            <p class="gate-priority">
              ① 可容纳人数必须为正整数：缺失提示补齐；填成 0、负数或其他无效值一律退回重填，此步不过直接拦下。
              ② 人数有效后再看开放条件：未登记或载明当前不开放的，不予启用。
            </p>
            <ul class="gate-reasons">
              <li v-for="(reason, index) in gateReasons" :key="index" class="warn-text">{{ reason.message }}</li>
              <li v-if="!gateReasons.length" class="ok-text">校验通过：人数有效，开放条件具备，可确认启用。</li>
            </ul>
            <p v-if="String(selected.status) === '待核验'" class="muted-text">
              批量补填可容纳人数并提交复核，请点右上角「批量复核 / 启用」；复核通过后会自动在削坡减载台账挂一条已落实场所。
            </p>
            <p v-if="String(selected.status) === '已启用' || String(selected.status) === '已关闭'" class="muted-text">
              环节顺序：待核验 → 可启用 → 已启用 → 已关闭，只允许逐级流转。
            </p>
          </section>
        </template>
        <p v-else class="empty-state detail-empty">
          请在左侧选择一条场所查看详情；当前没有可展示的避险场所时，可先登记或调整筛选条件。
        </p>
      </article>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条避险场所记录 · 环节顺序：待核验 → 可启用 → 已启用 → 已关闭</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <ReviewDrawer :open="drawerOpen" :tab="drawerTab" :rows="rows" @close="drawerOpen = false" @applied="reload" />
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  CAPACITY_FIELD,
  capacityProblem,
  evaluateEnableGate,
  parseCapacity,
  readOpenCondition,
} from '@/api/refuge-service'
import type { EntryRow } from '@/data/types'

import ReviewDrawer from './ReviewDrawer.vue'

const meta = moduleMeta('refuge')
const columns = ['场所编号', '场所名称', '可容纳人数', '开放条件', '场所负责人', '联系电话', '启用日期', '场所状态']
const detailFields = columns
const statuses = ['待核验', '可启用', '已启用', '已关闭']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const selectedId = ref<number | null>(null)
const drawerOpen = ref(false)
const drawerTab = ref<'review' | 'enable'>('review')

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const stats = computed(() => {
  const countOf = (status: string) => rows.value.filter((row) => String(row.status) === status).length
  const enabledCapacity = rows.value
    .filter((row) => String(row.status) === '已启用')
    .reduce((sum, row) => sum + (parseCapacity(row[CAPACITY_FIELD]) ?? 0), 0)
  return [
    { label: '可启用场所', value: countOf('可启用') },
    { label: '已启用场所', value: countOf('已启用') },
    { label: '已启用可容纳人数合计', value: enabledCapacity },
  ]
})

const selected = computed(() => rows.value.find((row) => Number(row.id) === selectedId.value) ?? null)

const gateReasons = computed(() => (selected.value ? evaluateEnableGate(selected.value).reasons : []))

function detailValue(column: string): string {
  if (!selected.value) {
    return '—'
  }
  if (column === CAPACITY_FIELD) {
    const raw = selected.value[column]
    if (raw === null || raw === undefined || String(raw).trim() === '') {
      return '（未填写，请补齐）'
    }
    return parseCapacity(raw) === null ? `${raw}（无效，必须为正整数，请退回重填）` : String(raw)
  }
  if (column === '开放条件') {
    return readOpenCondition(selected.value) || '（未登记）'
  }
  const value = selected.value[column]
  return value === null || value === undefined || value === '' ? '—' : String(value)
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openDrawer(tab: 'review' | 'enable') {
  drawerTab.value = tab
  drawerOpen.value = true
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    if (!rows.value.some((row) => Number(row.id) === selectedId.value)) {
      selectedId.value = rows.value.length ? Number(rows.value[0].id) : null
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '避险场所列表读取失败'
  }
}

onMounted(reload)
</script>
