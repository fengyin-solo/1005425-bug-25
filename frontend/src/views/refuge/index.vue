<template>
  <section class="page" data-module="refuge">
    <header class="page-head">
      <div>
        <h2>避险场所管理</h2>
        <p class="page-desc">维护避险场所，围绕场所编号、场所名称、可容纳人数、开放条件做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记避险场所</button>
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

    <section class="batch-bar">
      <div class="batch-actions">
        <button class="btn primary" type="button" @click="runBatch('review')">批量提交核验</button>
        <button class="btn primary" type="button" @click="runBatch('enable')">批量确认启用</button>
        <span class="batch-hint">
          逐条校验：人数缺失的单独拦下提示补齐、无效值退回重填，同批其他场所照常流转，不整批失败。
        </span>
      </div>
      <div v-if="batchOutcome" class="batch-result">
        <p :class="['batch-summary', batchOutcome.empty ? 'empty' : batchOutcome.failed === 0 ? 'ok' : 'warn']">
          {{ batchOutcome.summary }}
        </p>
        <ul v-if="!batchOutcome.empty && batchOutcome.items.length" class="batch-items">
          <li v-for="item in batchOutcome.items" :key="item.id" :class="item.ok ? 'ok' : 'fail'">
            {{ item.code }}：{{ item.message }}
          </li>
        </ul>
      </div>
    </section>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table refuge-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
          <th>详情</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            <template v-if="column === '场所编号'">
              <RouterLink class="link" :to="{ name: 'refuge-detail', params: { id: row.id } }">
                {{ row[column] }}
              </RouterLink>
            </template>
            <template v-else-if="column === '可容纳人数'">
              <span :class="['capacity-badge', capacityViewOf(row[column]).tone]">
                {{ capacityViewOf(row[column]).text }}
              </span>
            </template>
            <template v-else-if="column === '开放条件'">
              <span :class="['opening-badge', isOpeningMet(row[column]) ? 'ok' : 'bad']">
                {{ row[column] === '' ? '未填写' : row[column] }}
              </span>
            </template>
            <template v-else>{{ row[column] === '' || row[column] == null ? '—' : row[column] }}</template>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-if="nextActionFor(String(row.status))"
              class="link"
              type="button"
              @click="runAction(nextActionFor(String(row.status)), row)"
            >
              {{ nextActionFor(String(row.status)) }}
            </button>
            <span v-else class="muted-text">已到末环节</span>
          </td>
          <td>
            <button class="link" type="button" @click="openDrawer(row)">抽屉查看</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无避险场所数据，可先登记避险场所</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条避险场所记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <Teleport to="body">
      <div v-if="drawerId !== null" class="drawer-mask" @click.self="closeDrawer">
        <aside class="drawer-panel" role="dialog" aria-modal="true" aria-label="避险场所详情">
          <RefugeDetailPanel :id="drawerId" embedded @close="closeDrawer" @changed="onPanelChanged" />
        </aside>
      </div>
    </Teleport>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadEntries, filterRows, listEntries, moduleMeta } from '@/api/local-service'
import {
  batchEnable,
  batchReview,
  closeRefuge,
  describeCapacity,
  enableRefuge,
  isOpeningMet,
  nextActionFor,
  reviewRefuge,
  type BatchOutcome,
} from '@/api/refuge-service'
import { listRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

import RefugeDetailPanel from './RefugeDetailPanel.vue'

const meta = moduleMeta('refuge')
const columns = ['场所编号', '场所名称', '可容纳人数', '开放条件', '场所负责人', '联系电话', '启用日期', '场所状态']
const statuses = ['待核验', '可启用', '已启用', '已关闭']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const batchOutcome = ref<BatchOutcome | null>(null)
const drawerId = ref<number | null>(null)

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const stats = computed(() => {
  const all = filterRows(listRows(meta.key), filters.value)
  const enableable = all.filter((row) => String(row.status) === '可启用').length
  const enabled = all.filter((row) => String(row.status) === '已启用').length
  const capacityTotal = all
    .filter((row) => describeCapacity(row['可容纳人数']).tone === 'ok')
    .reduce((sum, row) => sum + Number(row['可容纳人数']), 0)
  return [
    { label: '可启用场所', value: enableable },
    { label: '已启用场所', value: enabled },
    { label: '可容纳人数合计（有效）', value: capacityTotal },
  ]
})

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '避险场所登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  batchOutcome.value = null
  const runner = action === '提交核验' ? reviewRefuge : action === '确认启用' ? enableRefuge : closeRefuge
  const result = runner(Number(row.id))
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function runBatch(kind: 'review' | 'enable') {
  errorMessage.value = ''
  batchOutcome.value = kind === 'review' ? batchReview() : batchEnable()
  reload()
}

function openDrawer(row: EntryRow) {
  drawerId.value = Number(row.id)
}

function capacityViewOf(raw: unknown) {
  return describeCapacity(raw)
}

function closeDrawer() {
  drawerId.value = null
}

function onPanelChanged() {
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '避险场所列表读取失败'
  }
}

onMounted(reload)
</script>
