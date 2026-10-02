<template>
  <Teleport to="body">
    <div v-if="open" class="drawer-mask" @click.self="close">
      <aside class="drawer-panel" role="dialog" aria-label="场所复核与启用">
        <header class="drawer-head">
          <div class="drawer-tabs">
            <button
              type="button"
              :class="['drawer-tab', { active: activeTab === 'review' }]"
              @click="switchTab('review')"
            >
              批量复核（待核验）
            </button>
            <button
              type="button"
              :class="['drawer-tab', { active: activeTab === 'enable' }]"
              @click="switchTab('enable')"
            >
              批量启用（可启用）
            </button>
          </div>
          <button type="button" class="link" @click="close">关闭</button>
        </header>

        <div class="drawer-body">
          <!-- 复核 -->
          <div v-if="activeTab === 'review'" class="drawer-section">
            <p class="drawer-tip">
              逐条核验、部分放行：可容纳人数缺失的单独拦下并提示补齐；填成 0、负数或其他无效值的一律退回重填；
              同批其他场所照常通过，并在削坡减载台账挂一条已落实场所（同一编号只挂一条）。
            </p>

            <div v-if="reviewRows.length" class="drawer-toolbar">
              <label class="drawer-check">
                <input
                  type="checkbox"
                  :checked="allReviewSelected"
                  @change="toggleAll('review', ($event.target as HTMLInputElement).checked)"
                />
                全选本环节 {{ reviewRows.length }} 条
              </label>
              <button type="button" class="btn primary" @click="submitReview">提交复核（{{ reviewSelected.length }} 条）</button>
            </div>

            <ul v-if="reviewRows.length" class="review-list">
              <li v-for="row in reviewRows" :key="String(row.id)" class="review-item">
                <label class="drawer-check">
                  <input type="checkbox" :checked="reviewSelected.includes(Number(row.id))" @change="toggleOne(Number(row.id), $event)" />
                </label>
                <div class="review-fields">
                  <div class="review-line">
                    <strong>{{ row['场所编号'] }}</strong>
                    <span>{{ row['场所名称'] }}</span>
                  </div>
                  <label class="capacity-edit">
                    <span>可容纳人数</span>
                    <input
                      v-model="drafts[Number(row.id)]"
                      type="text"
                      inputmode="numeric"
                      placeholder="缺失，请补齐正整数"
                    />
                  </label>
                  <p class="condition-line">开放条件：{{ openConditionText(row) || '（未登记）' }}</p>
                  <span :class="['gate-chip', gateLevel(row)]">{{ gateText(row) }}</span>
                </div>
              </li>
            </ul>
            <p v-else class="empty-state drawer-empty">
              当前没有待核验场所：新登记的场所会进入待核验环节，已复核的都在「可启用」里。
            </p>
          </div>

          <!-- 启用 -->
          <div v-else class="drawer-section">
            <p class="drawer-tip">
              启用门禁按优先级判定，顺序即优先级：① 可容纳人数是硬指标，缺失提示补齐，0、负数或无效值退回重填，这一步不过直接拦下；
              ② 人数有效后才看开放条件，未登记或载明当前不开放的不予启用。逐条放行，不整批失败。
            </p>

            <div v-if="enableRows.length" class="drawer-toolbar">
              <label class="drawer-check">
                <input
                  type="checkbox"
                  :checked="allEnableSelected"
                  @change="toggleAll('enable', ($event.target as HTMLInputElement).checked)"
                />
                全选本环节 {{ enableRows.length }} 条
              </label>
              <button type="button" class="btn primary" @click="submitEnable">确认启用（{{ enableSelected.length }} 条）</button>
            </div>

            <ul v-if="enableRows.length" class="review-list">
              <li v-for="row in enableRows" :key="String(row.id)" class="review-item">
                <label class="drawer-check">
                  <input type="checkbox" :checked="enableSelected.includes(Number(row.id))" @change="toggleOne(Number(row.id), $event)" />
                </label>
                <div class="review-fields">
                  <div class="review-line">
                    <strong>{{ row['场所编号'] }}</strong>
                    <span>{{ row['场所名称'] }}</span>
                  </div>
                  <div class="review-line meta">
                    <span>可容纳人数：{{ capacityText(row) }}</span>
                  </div>
                  <p class="condition-line">开放条件：{{ openConditionText(row) || '（未登记）' }}</p>
                  <span :class="['gate-chip', gateLevel(row)]">{{ gateText(row) }}</span>
                </div>
              </li>
            </ul>
            <p v-else class="empty-state drawer-empty">
              当前没有可启用场所：请先在「批量复核」里让待核验场所通过，或按提示补齐被拦下场所的可容纳人数、开放条件后再来。
            </p>
          </div>

          <div v-if="result" class="drawer-result">
            <h4 :class="result.blockedCount ? 'warn-text' : 'ok-text'">{{ result.message }}</h4>
            <ul>
              <li v-for="item in result.items" :key="item.id" :class="['result-line', item.ok ? 'ok-text' : item.level === 'skipped' ? 'muted-text' : 'warn-text']">
                {{ item.message }}
              </li>
            </ul>
            <button type="button" class="btn" @click="resetPanel">继续处理</button>
          </div>
        </div>
      </aside>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import type { BatchResult } from '@/api/local-service'
import { batchEnableRefuge, batchReviewRefuge } from '@/api/local-service'
import {
  CAPACITY_FIELD,
  evaluateEnableGate,
  readOpenCondition,
} from '@/api/refuge-service'
import type { EntryRow } from '@/data/types'

const props = defineProps<{ open: boolean; tab: 'review' | 'enable'; rows: EntryRow[] }>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'applied'): void }>()

const activeTab = ref<'review' | 'enable'>(props.tab)
const selected = ref<number[]>([])
const drafts = ref<Record<number, string>>({})
const result = ref<BatchResult | null>(null)

const reviewRows = computed(() => props.rows.filter((row) => String(row.status) === '待核验'))
const enableRows = computed(() => props.rows.filter((row) => String(row.status) === '可启用'))

const currentRows = computed(() => (activeTab.value === 'review' ? reviewRows.value : enableRows.value))
const reviewSelected = computed(() => selected.value.filter((id) => reviewRows.value.some((row) => Number(row.id) === id)))
const enableSelected = computed(() => selected.value.filter((id) => enableRows.value.some((row) => Number(row.id) === id)))
const allReviewSelected = computed(() => reviewRows.value.length > 0 && reviewSelected.value.length === reviewRows.value.length)
const allEnableSelected = computed(() => enableRows.value.length > 0 && enableSelected.value.length === enableRows.value.length)

watch(
  () => props.open,
  (open) => {
    if (open) {
      activeTab.value = props.tab
      resetPanel()
    }
  },
)

function switchTab(tab: 'review' | 'enable') {
  activeTab.value = tab
  resetPanel()
}

function resetPanel() {
  result.value = null
  const draftMap: Record<number, string> = {}
  for (const row of reviewRows.value) {
    draftMap[Number(row.id)] = row[CAPACITY_FIELD] === undefined || row[CAPACITY_FIELD] === null ? '' : String(row[CAPACITY_FIELD])
  }
  drafts.value = draftMap
  selected.value = currentRows.value.map((row) => Number(row.id))
}

function toggleOne(id: number, event: Event) {
  const checked = (event.target as HTMLInputElement).checked
  if (checked) {
    if (!selected.value.includes(id)) {
      selected.value = [...selected.value, id]
    }
  } else {
    selected.value = selected.value.filter((item) => item !== id)
  }
}

function toggleAll(tab: 'review' | 'enable', checked: boolean) {
  const rows = tab === 'review' ? reviewRows.value : enableRows.value
  const ids = rows.map((row) => Number(row.id))
  selected.value = checked
    ? Array.from(new Set([...selected.value, ...ids]))
    : selected.value.filter((id) => !ids.includes(id))
}

function effectiveRow(row: EntryRow): EntryRow {
  const draft = drafts.value[Number(row.id)]
  return draft === undefined ? row : { ...row, [CAPACITY_FIELD]: draft }
}

function openConditionText(row: EntryRow): string {
  // 与详情面板、启用门禁走同一个读取口径。
  return readOpenCondition(row)
}

function capacityText(row: EntryRow): string {
  const raw = effectiveRow(row)[CAPACITY_FIELD]
  return raw === undefined || raw === null || String(raw).trim() === '' ? '（未填写）' : String(raw)
}

function gateLevel(row: EntryRow): string {
  const gate = evaluateEnableGate(effectiveRow(row))
  if (gate.pass) {
    return 'chip-ok'
  }
  const level = gate.reasons[0]?.level
  return level === 'blocked' ? 'chip-warn' : level === 'missing' ? 'chip-missing' : 'chip-invalid'
}

function gateText(row: EntryRow): string {
  const gate = evaluateEnableGate(effectiveRow(row))
  if (gate.pass) {
    return '校验通过：人数有效，开放条件具备'
  }
  return gate.reasons[0]?.message ?? ''
}

function submitReview() {
  result.value = batchReviewRefuge(selected.value, drafts.value)
  emit('applied')
}

function submitEnable() {
  result.value = batchEnableRefuge(selected.value)
  emit('applied')
}

function close() {
  emit('close')
}
</script>
